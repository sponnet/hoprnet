import { Stream } from './types'
import Multiaddr from 'multiaddr'
import BL from 'bl'
import { MultiaddrConnection } from './types'
import Defer, { DeferredPromise } from 'p-defer'
import { RELAY_PAYLOAD_PREFIX, RELAY_STATUS_PREFIX, RELAY_WEBRTC_PREFIX, STOP } from './constants'
import { u8aEquals } from '@hoprnet/hopr-utils'

import type { Instance as SimplePeer } from 'simple-peer'

import type PeerId from 'peer-id'

import Debug from 'debug'

const error = Debug('hopr-core:transport:error')

class RelayConnection implements MultiaddrConnection {
  private _defer: DeferredPromise<void>
  private _stream: Stream
  private _destroyed: boolean
  private _sinkTriggered: boolean
  private _triggerSink: DeferredPromise<AsyncGenerator>
  private webRTC: SimplePeer
  public localAddr: Multiaddr
  public remoteAddr: Multiaddr

  public source: AsyncGenerator<Uint8Array, Uint8Array | void>
  public sink: (source: AsyncGenerator<Uint8Array, Uint8Array | void>) => Promise<void>

  public conn: Stream

  public timeline: {
    open: number
    close?: number
  }

  constructor({
    stream,
    self,
    counterparty,
    webRTC,
  }: {
    stream: Stream
    self: PeerId
    counterparty: PeerId
    webRTC?: SimplePeer
  }) {
    this.timeline = {
      open: Date.now(),
    }

    this._defer = Defer()
    this._triggerSink = Defer()

    this._destroyed = false
    this._sinkTriggered = false

    this._stream = stream

    this.localAddr = Multiaddr(`/p2p/${self.toB58String()}`)
    this.remoteAddr = Multiaddr(`/p2p/${counterparty.toB58String()}`)

    this.webRTC = webRTC

    this.source = async function* (this: RelayConnection) {
      const promise = this._defer.promise.then(() => ({ done: true }))

      while (true) {
        let result: {
          done?: boolean
          value?: Uint8Array | void
        } = await Promise.race([
          // prettier-ignore
          // @ts-ignore
          this._stream.source.next(),
          promise,
        ])

        if (result.value != null) {
          const received = (result.value as Uint8Array).slice()

          if (u8aEquals(received.slice(0, 1), RELAY_PAYLOAD_PREFIX)) {
            if (result.done) {
              this._destroyed = true
              return received.slice(1)
            } else {
              yield received.slice(1)
            }
          } else if (u8aEquals(received.slice(0, 1), RELAY_STATUS_PREFIX)) {
            if (u8aEquals(received.slice(1), STOP) || result.done) {
              this._destroyed = true
              return
            } else {
              error(`Received invalid status message ${received.slice(1)}. Dropping message.`)
            }
          } else if (u8aEquals(received.slice(0, 1), RELAY_WEBRTC_PREFIX)) {
            setImmediate(this.webRTC?.signal.bind(this.webRTC), JSON.parse(new TextDecoder().decode(received.slice(1))))
          } else {
            error(`Received invalid prefix <${received.slice(0, 1)}. Dropping message.`)
          }
        } else if (result.done) {
          if (!this._destroyed) {
            // @TODO
            // if (!this._sinkTriggered) {
            //   this._stream.sink(
            //     (async function* () {
            //       yield (new BL([
            //         (RELAY_STATUS_PREFIX as unknown) as BL,
            //         (STOP as unknown) as BL,
            //       ]) as unknown) as Uint8Array
            //     })()
            //   )
            // }
            this._destroyed = true
          }
          return
        }
      }
    }.call(this)

    this._stream.sink(
      async function* (this: RelayConnection) {
        let streamReceived = false
        let attachedSource: AsyncGenerator<Uint8Array, Uint8Array | void>
        const sinkPromise = this._triggerSink.promise.then((_source: AsyncGenerator<Uint8Array, Uint8Array | void>) => {
          console.log(`sinkPromise`)
          streamReceived = true
          attachedSource = _source
        })

        let webRTCresolved = false
        let webRTCDone = this.webRTC == null
        let webRTCmsg: Uint8Array | void

        function webRTCSourceFunction({ done, value }: { done?: boolean; value: Uint8Array | void }) {
          webRTCresolved = true
          webRTCmsg = value

          if (done) {
            webRTCDone = true
          }
        }

        let webRTCStream: AsyncGenerator<Uint8Array, Uint8Array | void>
        let webRTCPromise: Promise<void>

        if (this.webRTC != null) {
          webRTCStream = this.getWebRTCStream()
          webRTCPromise = webRTCStream.next().then(webRTCSourceFunction)
        }

        let promiseDone = false
        const promise = this._defer.promise.then(() => {
          promiseDone = true
        })

        let streamResolved = false
        let streamDone = false
        let streamMsg: Uint8Array

        function streamSourceFunction({ done, value }: { done?: boolean; value?: Uint8Array | void }) {
          streamResolved = true

          if (value != null) {
            streamMsg = value as Uint8Array
          }

          if (done) {
            streamDone = true
          }
        }

        let streamPromise: Promise<void>

        while (true) {
          // await new Promise((resolve) => setTimeout(resolve, 500))

          if (this.webRTC != null && !streamReceived) {
            if (!webRTCDone) {
              await Promise.race([
                // prettier-ignore
                webRTCPromise,
                sinkPromise,
              ])

              if (webRTCresolved) {
                webRTCresolved = false

                if (!webRTCDone) {
                  webRTCPromise = webRTCStream.next().then(webRTCSourceFunction)
                }

                if (webRTCmsg != null) {
                  yield new BL([(RELAY_WEBRTC_PREFIX as unknown) as BL, (webRTCmsg as unknown) as BL])
                }
              }
            } else {
              await sinkPromise
            }
          } else if (streamReceived) {
            if (streamPromise == null) {
              streamPromise = attachedSource.next().then(streamSourceFunction)
            }
            if (!webRTCDone && this.webRTC != null) {
              console.log(`before second await`)
              await Promise.race([
                // prettier-ignore
                // @ts-ignore
                streamPromise,
                webRTCPromise,
                promise,
              ])
            } else {
              await Promise.race([
                // prettier-ignore
                // @ts-ignore
                streamPromise,
                promise,
              ])
            }

            //console.log(`after await`, streamResolved, streamMsg, attachedSource, webRTCresolved, promiseDone)

            if (streamResolved) {
              streamResolved = false

              if (streamMsg == null) {
                streamPromise = attachedSource.next().then(streamSourceFunction)
                yield streamMsg
              } else {
                let _received = streamMsg.slice()

                if (promiseDone || (streamDone && webRTCDone)) {
                  if (_received != null) {
                    yield new BL([(RELAY_PAYLOAD_PREFIX as unknown) as BL, (_received as unknown) as BL])
                  }

                  this._destroyed = true

                  return (new BL([
                    (RELAY_STATUS_PREFIX as unknown) as BL,
                    (STOP as unknown) as BL,
                  ]) as unknown) as Uint8Array
                } else {
                  if (_received == null) {
                    // @TODO change this to `return` to end the stream
                    // once we receive an empty message
                    continue
                  }

                  yield new BL([(RELAY_PAYLOAD_PREFIX as unknown) as BL, (_received as unknown) as BL])

                  // @ts-ignore
                  streamPromise = attachedSource.next().then(streamSourceFunction)
                }
              }
            }
            if (webRTCresolved && webRTCmsg != null) {
              webRTCresolved = false
              if (promiseDone || (streamDone && webRTCDone)) {
                // @ts-ignore
                return new BL([RELAY_WEBRTC_PREFIX, webRTCmsg])
              } else {
                // @ts-ignore
                yield new BL([RELAY_WEBRTC_PREFIX, webRTCmsg])
              }

              webRTCPromise = webRTCStream.next().then(webRTCSourceFunction)
            }
            if (promiseDone || (streamDone && webRTCDone)) {
              if (!this._destroyed) {
                this._destroyed = true

                return (new BL([
                  (RELAY_STATUS_PREFIX as unknown) as BL,
                  (STOP as unknown) as BL,
                ]) as unknown) as Uint8Array
              }

              return
            }
          }
        }
      }.call(this)
    )

    this.sink = async (source: AsyncGenerator<Uint8Array, Uint8Array | void>): Promise<void> => {
      this._triggerSink.resolve(source)
    }
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  close(err?: Error): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve()
    }

    this._defer.resolve()

    this.timeline.close = Date.now()

    return Promise.resolve()
  }

  private getWebRTCStream() {
    return async function* (this: RelayConnection) {
      let defer = Defer<DeferredPromise<any>>()
      let waiting = false
      const webRTCmessages: Uint8Array[] = []
      let done = false

      function onSignal(msg: any) {
        webRTCmessages.push(new TextEncoder().encode(JSON.stringify(msg)))
        if (waiting) {
          waiting = false
          defer.resolve(Defer<DeferredPromise<any>>())
        }
      }
      this.webRTC.on('signal', onSignal)

      this.webRTC.once('connect', () => {
        done = true
        this.webRTC.removeListener('signal', onSignal)
        defer.resolve()
      })

      while (!done) {
        while (webRTCmessages.length > 0) {
          yield webRTCmessages.shift()
        }

        if (done) {
          break
        }

        waiting = true
        defer = await defer.promise

        if (done) {
          break
        }
      }
    }.call(this)
  }
}

export { RelayConnection }
