import { MultiaddrConnection, Stream } from './types'
import Defer, { DeferredPromise } from 'p-defer'

import type { Readable, Writable, Duplex } from 'stream'

import type { Instance as SimplePeer } from 'simple-peer'
import Multiaddr from 'multiaddr'
import type PeerId from 'peer-id'

declare interface toIterable {
  sink(stream: Writable): (source: AsyncGenerator) => Promise<void>
  source(stream: Readable): AsyncGenerator
  duplex(
    stream: Duplex
  ): {
    sink: AsyncGenerator
    source: AsyncGenerator
  }
}

// @ts-ignore
const toIterable: toIterable = require('stream-to-it')

class WebRTCConnection implements MultiaddrConnection {
  private _switchPromise: DeferredPromise<void>
  private _webRTCStateKnown: boolean
  private _webRTCAvailable: boolean
  private _migrated: boolean

  public source: AsyncGenerator<Uint8Array, Uint8Array | void>

  public remoteAddr: Multiaddr
  public localAddr: Multiaddr

  public sink: (source: AsyncGenerator<Uint8Array, Uint8Array | void>) => Promise<void>

  public timeline: {
    open: number
    closed?: number
  }

  constructor(
    public conn: MultiaddrConnection,
    private channel: SimplePeer,
    private self: PeerId,
    private counterparty: PeerId
  ) {
    this._switchPromise = Defer<void>()
    this._webRTCStateKnown = false
    this._webRTCAvailable = false

    this.remoteAddr = Multiaddr(`/p2p/${self.toB58String()}`)
    this.localAddr = Multiaddr(`/p2p/${counterparty.toB58String()}`)

    this.channel.on('connect', () => {
      this.timeline = {
        open: Date.now(),
      }
      this._webRTCStateKnown = true
      this._webRTCAvailable = true
      this._switchPromise.resolve()
    })

    this.channel.on('error', () => {
      this._webRTCStateKnown = true
      this._webRTCAvailable = false
      this._switchPromise.resolve()
    })

    this.sink = async (source: AsyncGenerator<Uint8Array, Uint8Array | void>) => {
      this.conn.sink(
        async function* (this: WebRTCConnection) {
          let sourceReceived = false
          let sourceMsg: Uint8Array | void
          let sourceDone = false

          function sourceFunction({ value, done }: { value?: Uint8Array | void; done?: boolean | void }) {
            sourceReceived = true
            sourceMsg = value

            if (done) {
              sourceDone = true
            }
          }

          let sourcePromise = source.next().then(sourceFunction)

          while (!this._webRTCStateKnown) {
            await Promise.race([
              // prettier-ignore
              sourcePromise,
              this._switchPromise.promise,
            ])

            if (sourceReceived) {
              sourceReceived = false

              if (sourceDone && this._webRTCStateKnown && !this._webRTCAvailable) {
                return sourceMsg
              } else {
                sourcePromise = source.next().then(sourceFunction)
                yield sourceMsg
              }
            }
          }
        }.call(this)
      )

      this._switchPromise.promise.then(() => {
        if (this._webRTCAvailable) {
          const sink = toIterable.sink(this.channel)
          this._migrated = true

          sink(source)
        } else {
          this.conn.sink(source)
        }
      })
    }

    this.source = async function* (this: WebRTCConnection) {
      let streamMsgReceived = false
      let streamMsg: Uint8Array | void
      let streamDone = false

      function streamSourceFunction({ value, done }: { value?: Uint8Array | void; done?: boolean | void }) {
        streamMsgReceived = true
        streamMsg = value

        if (done) {
          streamDone = true
        }
      }

      let streamPromise = this.conn.source.next().then(streamSourceFunction)

      while (!this._webRTCStateKnown) {
        await Promise.race([
          // prettier-ignore
          this.conn.source.next(),
          this._switchPromise.promise,
        ])

        if (streamMsgReceived) {
          streamMsgReceived = false
          if (streamDone) {
            return streamMsg
          } else {
            streamPromise = this.conn.source.next().then(streamSourceFunction)
            yield streamMsg
          }
        }
      }

      let webRTCMsgreceived = false
      let webRTCMsg: Uint8Array | void
      let webRTCDone = false

      function webRTCSourceFunction({ value, done }: { value?: Uint8Array | void; done?: boolean | void }) {
        webRTCMsgreceived = true
        webRTCMsg = value

        if (done) {
          webRTCDone = true
        }
      }

      let webRTCstream = this.channel[Symbol.asyncIterator]()
      let webRTCPromise = webRTCstream.next().then(webRTCSourceFunction)

      if (this._webRTCAvailable) {
        while (!streamDone) {
          await Promise.race([
            // prettier-ignore
            webRTCPromise,
            streamPromise,
          ])

          if (webRTCMsgreceived) {
            webRTCMsgreceived = false

            if (webRTCDone && streamDone) {
              return webRTCMsg
            } else {
              webRTCPromise = webRTCstream.next().then(webRTCSourceFunction)
              yield webRTCMsg
            }
          }

          if (streamMsgReceived) {
            streamMsgReceived = false

            if (webRTCDone && streamDone) {
              return streamMsg
            } else {
              streamPromise = this.source.next().then(webRTCSourceFunction)
              yield streamMsg
            }
          }
        }
        this._migrated = true
        yield* webRTCstream
      } else {
        yield* this.conn.source
      }
    }.call(this)
  }

  async close(err?: Error): Promise<void> {
    if (this.timeline == null) {
      this.timeline = {
        open: Date.now(),
        closed: Date.now(),
      }
    } else {
      this.timeline.closed = Date.now()
    }

    if (this._migrated) {
      return Promise.resolve(this.channel.destroy())
    } else {
      return Promise.all([this.channel.destroy(), this.conn.close()]).then(() => {})
    }
  }
}

export { WebRTCConnection }
