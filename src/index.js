'use strict'

const libp2p = require('libp2p')
const MPLEX = require('libp2p-mplex')
const KadDHT = require('libp2p-kad-dht')
// const SECIO = require('libp2p-secio')
const { WebRTCv4, WebRTCv6 } = require('./network/natTraversal')

const defaultsDeep = require('@nodeutils/defaults-deep')

const { createPacket } = require('./packet')
const registerHandlers = require('./handlers')
const { NAME, PACKET_SIZE, PROTOCOL_STRING, MAX_HOPS } = require('./constants')
const crawler = require('./network/crawler')
const heartbeat = require('./network/heartbeat')
const getPubKey = require('./getPubKey')
const getPeerInfo = require('./getPeerInfo')
const { randomSubset, serializePeerBook, deserializePeerBook, log, match, createDirectoryIfNotExists } = require('./utils')

const levelup = require('levelup')
const leveldown = require('leveldown')

const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const PeerBook = require('peer-book')

const PaymentChannels = require('./paymentChannels')
const PublicIp = require('./network/natTraversal/stun')

const pull = require('pull-stream')
const lp = require('pull-length-prefixed')
const Acknowledgement = require('./acknowledgement')

class Hopr extends libp2p {
    /**
     * @constructor
     *
     * @param {Object} _options
     * @param {Object} provider
     */
    constructor(_options, db, bootstrapServers) {
        if (!_options || !_options.peerInfo || !PeerInfo.isPeerInfo(_options.peerInfo))
            throw Error("Invalid input parameters. Expected a valid PeerInfo, but got '" + typeof _options.peerInfo + "' instead.")

        const defaults = {
            // Disable libp2p-switch protections for the moment
            switch: {
                denyTTL: 1,
                denyAttempts: Infinity
            },
            // The libp2p modules for this libp2p bundle
            modules: {
                /**
                 * The transport modules to use.
                 */
                transport: [
                    // TCP,
                    WebRTCv4,
                    WebRTCv6
                ],
                /**
                 * To support bidirectional connection, we need a stream muxer.
                 */
                streamMuxer: [MPLEX],
                /**
                 * Let's have TLS-alike encrypted connections between the nodes.
                 */
                connEncryption: [], //  [SECIO],
                /**
                 * Necessary to have DHT lookups
                 */
                dht: KadDHT
                /**
                 * Necessary to use WebRTC (and to support proper NAT traversal)
                 */
                // peerDiscovery: [
                //     WebRTC.discovery
                // ]
            },
            config: {
                // peerDiscovery: {
                //     webRTCStar: {
                //         enabled: true
                //     }
                // },
                dht: {
                    enabled: true
                },
                relay: {
                    enabled: false
                }
            }
        }
        super(defaultsDeep(_options, defaults))

        this.bootstrapServers = bootstrapServers
        this.db = db
        this.heartbeat = heartbeat(this)

        // Functionality to ask another node for its public key in case that the
        // public key is not available which is not necessary anymore.
        //
        // Notice: don't forget to activate the corresponding handler in `handlers/index.js`
        //
        this.getPubKey = getPubKey(this)
    }

    /**
     * Creates a new node and invokes @param cb with `(err, node)` when finished.
     *
     * @param {Object} options the parameters
     * @param {Object} options.web3provider a web3 provider, default `http://localhost:8545`
     * @param {String} options.contractAddress the Ethereum address of the contract
     * @param {Object} options.peerInfo
     */
    static async createNode(options = {}) {
        options.output = options.output || console.log

        const db = Hopr.openDatabase(`db`, options)

        // peerBook: (cb) => {
        //     if (options.peerBook) {
        //         cb(null, options.peerBook)
        //     } else {
        //         Hopr.importPeerBook(db, cb)
        //     }
        // }

        const hopr = new Hopr(
            {
                config: {
                    // WebRTC: options.WebRTC
                },
                // peerBook: peerBook,
                peerInfo: await getPeerInfo(options, db)
            },
            db,
            options.bootstrapServers
        )

        return hopr.start(options)
    }

    /**
     * Parses the bootstrap servers given in `.env` and tries to connect to each of them.
     *
     * @throws an error if none of the bootstrapservers is online
     */
    async connectToBootstrapServers() {
        const results = await Promise.all(this.bootstrapServers.map(addr => this.dial(addr).then(() => true, () => false)))

        if (!results.some(online => online)) throw Error('Unable to connect to any bootstrap server.')
    }

    /**
     * This method starts the node and registers all necessary handlers. It will
     * also open the database and creates one if it doesn't exists.
     *
     * @param {Object} options
     * @param {Function} options.output function to which the plaintext of the received message is passed
     */
    async start(options) {
        await super.start()

        registerHandlers(this, options)

        if (!options['bootstrap-node']) {
            await this.connectToBootstrapServers(options.bootstrapServers)
        }

        // this.heartbeat.start()
        // this.getPublicIp = PublicIp(this, options)

        this.crawler = new crawler({ libp2p: this })

        this.peerInfo.multiaddrs.forEach(addr => {
            if (match.LOCALHOST(addr)) {
                this.peerInfo.multiaddrs.delete(addr)
            }
        })

        if (!options['bootstrap-node']) {
            this.paymentChannels = await PaymentChannels.create(this)
        }

        // if (publicAddrs) publicAddrs.forEach(addr => this.peerInfo.multiaddrs.add(addr.encapsulate(`/${NAME}/${this.peerInfo.id.toB58String()}`)))
    }

    /**
     * Shuts down the node and saves keys and peerBook in the database
     */
    async stop() {
        log(this.peerInfo.id, `Shutting down...`)

        // this.heartbeat.stop()

        await Promise.all([
            this.exportPeerBook(),
            super.stop(),
            this.db.close()
        ])
    }

    /**
     * Sends a message.
     *
     * @notice THIS METHOD WILL SPEND YOUR ETHER.
     * @notice This method will fail if there are not enough funds to open
     * the required payment channels. Please make sure that there are enough
     * funds controlled by the given key pair.
     *
     * @param {Number | String | Buffer} msg message to send
     * @param {PeerId | PeerInfo | String} destination PeerId of the destination
     * the acknowledgement of the first hop
     */
    async sendMessage(msg, destination) {
        if (!msg) return cb(Error(`Expecting a non-empty message.`))

        if (!destination) return cb(Error(`Expecting a non-empty destination.`))

        if (PeerInfo.isPeerInfo(destination)) destination = destination.id

        if (typeof destination === 'string') destination = PeerId.createFromB58String(destination)

        if (!PeerId.isPeerId(destination))
            return cb(Error(`Unable to parse given destination to a PeerId instance. Got type ${typeof destination} with value ${destination}.`))

        // Let's try to convert input msg to a Buffer in case it isn't already a Buffer
        if (!Buffer.isBuffer(msg)) {
            switch (typeof msg) {
                default:
                    return cb(Error(`Invalid input value. Got '${typeof msg}'.`))
                case 'number':
                    msg = msg.toString()
                case 'string':
                    msg = Buffer.from(msg)
            }
        }

        const promises = []

        for (let n = 0; n < msg.length / PACKET_SIZE; n++) {
            promises.push(new Promise(async (resolve, reject) => {
                const intermediateNodes = await this.getIntermediateNodes(destination)

                await Promise.all(intermediateNodes.concat(destination).map(node => new Promise((resolve, reject) => {
                    this.getPubKey(node, (err, node) => {
                        if (err) return reject(err)

                        resolve(node)
                    })
                })))

                const [conn, packet] = await Promise.all([
                    new Promise((resolve, reject) =>
                        this.peerRouting.findPeer(intermediateNodes[0].id, async (err, peerInfo) => {
                            if (err) reject(err)

                            resolve(this.dialProtocol(peerInfo, PROTOCOL_STRING))
                        })
                    ),
                    createPacket(
                        this,
                        msg.slice(n * PACKET_SIZE, Math.min(msg.length, (n + 1) * PACKET_SIZE)),
                        intermediateNodes.map(peerInfo => peerInfo.id)
                    )
                ])

                pull(
                    pull.once(packet.toBuffer()),
                    lp.encode(),
                    conn,
                    lp.decode({
                        maxLength: Acknowledgement.SIZE
                    }),
                    pull.drain(data => {
                        log(this.peerInfo.id, `Received acknowledgement.`)
                        // return cb()
                        // if (!cb.called) {
                        //     return cb()
                        // }
                    }, resolve)
                )
            }))
        }

        try {
            await Promise.all(promises)
        } catch (err) {
            console.log(err)
        }
    }

    /**
     * Takes a destination and samples randomly intermediate nodes
     * that will relay that message before it reaches its destination.
     *
     * @param {Object} destination instance of peerInfo that contains the peerId of the destination
     */
    async getIntermediateNodes(destination) {
        const filter = peerInfo =>
            !peerInfo.id.isEqual(this.peerInfo.id) && !peerInfo.id.isEqual(destination) && !this.bootstrapServers.some(pInfo => pInfo.id.isEqual(peerInfo.id))

        await this.crawler.crawl()

        return randomSubset(this.peerBook.getAllArray(), MAX_HOPS - 1, filter).map(peerInfo => peerInfo.id)
    }

    async static importPeerBook(db) {
        const key = 'peer-book'

        const peerBook = new PeerBook()

        let serializedPeerBook
        try {
            serializedPeerbook = await db.get(key)
        } catch (err) {
            if (err.notFound) {
                return peerBook
            } else {
                throw err
            }
        }

        return deserializePeerBook(serializedPeerbook, peerBook)
    }

    async exportPeerBook() {
        const key = 'peer-book'

        await this.db.put(key, serializePeerBook(this.peerBook))
    }

    static openDatabase(db_dir, options) {
        if (options && Number.isInteger(options.id)) {
            // Only for unit testing !!!
            db_dir = `${db_dir}/node ${options.id}`
        } else if (options && options['bootstap-node']) {
            db_dir = `${db_dir}/bootstrap ${options.id}`
        }

        createDirectoryIfNotExists(db_dir)

        //     clearDirectory(db_dir)
        //     fs.mkdirSync(db_dir, {
        //         mode: 0o777
        //     })
        // --------------------------

        return levelup(leveldown(db_dir))
    }
}

module.exports = Hopr
