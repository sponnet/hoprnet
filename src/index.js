'use strict'

const withIs = require('class-is')

const { readFileSync } = require('fs')
const { resolve } = require('path')

const libp2p = require('libp2p')
const TCP = require('libp2p-tcp')
const MPLEX = require('libp2p-mplex')
const KadDHT = require('libp2p-kad-dht')
const SECIO = require('libp2p-secio')
const defaultsDeep = require('@nodeutils/defaults-deep')

const { isPeerInfo } = require('peer-info')


const Eth = require('web3-eth')


const { createPacket } = require('./packet')
const registerHandlers = require('./handlers')
const c = require('./constants')
const crawlNetwork = require('./crawlNetwork')
const getPubKey = require('./getPubKey')
const getPeerInfo = require('./getPeerInfo')

// DEMO
const { randomBytes } = require('crypto')
const { bufferToNumber, randomSubset } = require('./utils')
// END DEMO



// const wrtc = require('wrtc')
const WStar = require('libp2p-webrtc-star')
// const WebRTC = new WStar({
//     wrtc: wrtc
// })

const PaymentChannels = require('./paymentChannels')


const pull = require('pull-stream')
const { waterfall, times, parallel } = require('async')

// const BOOTSTRAP_NODE = Multiaddr('/ip4/127.0.0.1/tcp/9090/')

class Hopper extends libp2p {
    /**
     * @constructor
     * 
     * @param {Object} _options 
     * @param {Object} provider 
     */
    constructor(_options, provider) {
        if (!_options || !_options.peerInfo || !isPeerInfo(_options.peerInfo))
            throw Error('Invalid input parameters. Expected a valid PeerInfo, but got \'' + typeof _options.peerInfo + '\' instead.')

        const defaults = {
            // The libp2p modules for this libp2p bundle
            modules: {
                /**
                 * The transport modules to use.
                 */
                transport: [
                    TCP // WebRTC
                ],
                /**
                 * To support bidirectional connection, we need a stream muxer.
                 */
                streamMuxer: [
                    MPLEX
                ],
                /**
                 * Let's have TLS-alike encrypted connections between the nodes.
                 */
                connEncryption: [
                    SECIO
                ],
                /**
                 * Necessary to have DHT lookups
                 */
                dht: KadDHT
                /**
                 * Necessary to use WebRTC (and to support proper NAT traversal)
                 */
                // peerDiscovery: [WebRTC.discovery]
            },
            config: {
                EXPERIMENTAL: {
                    // libp2p DHT implementation is still hidden behind a flag
                    dht: true
                }
            }

        }
        super(defaultsDeep(_options, defaults))

        // Maybe this is not necessary
        this.eth = new Eth(provider)

        this.seenTags = new Set()
        this.pendingTransactions = new Map()
        this.crawlNetwork = crawlNetwork(this)
        this.getPubKey = getPubKey(this)
    }

    /**
     * Creates a new node and invokes @param cb with (err, node) when finished.
     * 
     * @param {Object} options 
     * @param {Function} cb callback when node is ready
     */
    static createNode(options = {}, cb = () => { }) {
        if (arguments.length < 2 && typeof options === 'function') {
            cb = options
            options = {}
        }

        options.provider = options.provider || 'http://localhost:8545'
        options.output = options.output || console.log
        options.contract = options.contract || new Eth.Contract(JSON.parse(readFileSync(resolve('./contracts/HoprChannel.abi'))))

        waterfall([
            (cb) =>
                isPeerInfo(options.peerInfo) ? cb(null, options.peerInfo) : getPeerInfo(null, cb),
            (peerInfo, cb) =>
                (new Hopper({ peerInfo: peerInfo }, options.provider, options.contract)).start(options.output, options.contract, cb),
        ], cb)
    }

    /**
     * This method starts the node and registers all necessary handlers.
     * 
     * @param {Function} output function to which the plaintext of the received message is passed
     * @param {Function} cb callback when node is ready
     */
    start(output, contract, cb) {
        waterfall([
            (cb) => super.start((err, _) => cb(err)),
            (cb) => PaymentChannels.createPaymentChannels(this, contract, cb),
            (cb) => registerHandlers(this, output, cb)
        ], cb)
    }

    /**
     * Send a message.
     * 
     * @notice THIS METHOD WILL SPEND YOUR ETHER.
     * @notice This method will fail if there are not enough funds to open
     * the required payment channels. Please make sure that there are enough
     * funds controlled by the given key pair.
     * 
     * @param {Number | String | Buffer} msg message to send
     * @param {Object} destination PeerId of the destination
     * @param {Function} cb function to call when finished
     */
    sendMessage(msg, destination, cb) {
        if (!msg)
            throw Error('Expecting non-empty message.')

        // Let's try to convert input msg to a Buffer in case it isn't already a Buffer
        if (!Buffer.isBuffer(msg)) {
            switch (typeof msg) {
                default:
                    throw Error('Invalid input value. Got \"' + typeof msg + '\".')
                case 'number': msg = msg.toString()
                case 'string': msg = Buffer.from(msg)
            }
        }

        times(Math.ceil(msg.length / c.PACKET_SIZE), (n, cb) => {
            let path

            waterfall([
                (cb) => this.getIntermediateNodes(destination, cb),
                (intermediateNodes, cb) => {
                    path = intermediateNodes.map(peerInfo => peerInfo.id).concat(destination)

                    this.peerRouting.findPeer(path[0], cb)
                },
                (peerInfo, cb) => parallel({
                    conn: (cb) => this.dialProtocol(peerInfo, c.PROTOCOL_STRING, cb),
                    packet: (cb) => createPacket(
                        this,
                        msg.slice(n * c.PACKET_SIZE, Math.min(msg.length, (n + 1) * c.PACKET_SIZE)),
                        path,
                        cb
                    )
                }, cb),
                ({ conn, packet }, cb) => {
                    pull(
                        pull.once(packet.toBuffer()),
                        conn
                    )
                    cb()
                }
            ], cb)
        }, cb)
    }

    getIntermediateNodes(destination, cb) {
        const comparator = (peerInfo) =>
            this.peerInfo.id.id.compare(peerInfo.id.id) !== 0 &&
            destination.id.compare(peerInfo.id.id) !== 0

        waterfall([
            (cb) => this.crawlNetwork(cb, comparator),
            (cb) => cb(null, randomSubset(
                this.peerBook.getAllArray(), c.MAX_HOPS - 1, comparator))
        ], cb)
    }
}

module.exports = withIs(Hopper, { className: 'hopper', symbolName: '@validitylabs/hopper/hopper' })