/**
 * The WebRTC media leg, on werift (pure TypeScript, no native code): the answering side of one
 * call. It offers only PCMU, gathers host candidates without STUN (Tailscale routes the peers
 * directly), and answers with every candidate in the SDP, so signalling is one HTTP round trip.
 */

import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  type RTCDataChannel,
  type RTCRtpTransceiver,
} from 'werift'
import { FRAME_SAMPLES, ulawDecode } from './audio.ts'
import type { CallMedia, MediaClosed, MediaFactory, MediaNetwork } from './media.ts'

/** RTP payload type of PCMU, fixed by RFC 3551. */
const PCMU_PAYLOAD_TYPE = 0
/** Label of the data channel the app opens for control messages. */
export const CONTROL_LABEL = 'control'
/** Longest wait for ICE gathering before the answer goes out with what it has. */
const GATHER_TIMEOUT_MS = 5000

/**
 * The werift media leg.
 * @param network - sockets and deadlines.
 * @returns a factory output for one call.
 */
export const createWebRtcMedia: MediaFactory = (network: MediaNetwork): CallMedia => new WebRtcMedia(network)

class WebRtcMedia implements CallMedia {
  private readonly pc: RTCPeerConnection
  private transceiver: RTCRtpTransceiver | undefined
  private channel: RTCDataChannel | undefined
  private readonly audioListeners: Array<(frame: Int16Array) => void> = []
  private readonly controlListeners: Array<(frame: string) => void> = []
  private readonly connectedListeners: Array<() => void> = []
  private readonly closedListeners: Array<(reason: MediaClosed) => void> = []
  private closed = false
  /** Received samples not yet a whole frame. */
  private readonly pending = new Int16Array(FRAME_SAMPLES)
  private pendingLength = 0
  private connected = false
  private mediaUp = false
  private sequence = Math.floor(Math.random() * 0x10000)
  private timestamp = Math.floor(Math.random() * 0x1_0000_0000)
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private graceTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly network: MediaNetwork) {
    this.pc = new RTCPeerConnection({
      codecs: {
        audio: [new RTCRtpCodecParameters({ mimeType: 'audio/PCMU', clockRate: 8000, channels: 1, payloadType: PCMU_PAYLOAD_TYPE })],
        video: [],
      },
      iceServers: [],
      iceUseDefaultStunServer: false,
      iceUseIpv6: network.ipv6,
      ...network.bindAddress === undefined
        ? {}
        : { iceInterfaceAddresses: { udp4: network.bindAddress }, iceAdditionalHostAddresses: [network.bindAddress] },
      ...network.portRange === undefined ? {} : { icePortRange: network.portRange },
    })
    this.pc.connectionStateChange.subscribe((state) => { this.onConnectionState(state) })
    this.pc.onDataChannel.subscribe((channel) => { this.adoptChannel(channel) })
    // Subscribed before the offer is applied: the track appears while setRemoteDescription runs.
    this.pc.onTrack.subscribe((track) => {
      if (track.kind === 'audio') track.onReceiveRtp.subscribe((rtp) => { this.receive(rtp) })
    })
  }

  async answer(offerSdp: string): Promise<string> {
    if (this.closed) throw new Error('the media leg is closed')
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
    const audio = this.pc.getTransceivers().find(transceiver => transceiver.kind === 'audio')
    if (audio === undefined) throw new Error('the offer has no audio')
    audio.setDirection('sendrecv')
    this.transceiver = audio
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await this.gathered()
    const local = this.pc.localDescription
    if (local === null) throw new Error('no local description after gathering')
    if (!/^a=candidate:/mu.test(local.sdp)) throw new Error('no local ICE candidate was gathered; check ice.bindAddress')
    this.connectTimer = setTimeout(() => { this.finish('timeout') }, this.network.connectTimeoutMs)
    return local.sdp
  }

  onAudio(listener: (frame: Int16Array) => void): void {
    this.audioListeners.push(listener)
  }

  onControl(listener: (frame: string) => void): void {
    this.controlListeners.push(listener)
  }

  onConnected(listener: () => void): void {
    this.connectedListeners.push(listener)
  }

  onClosed(listener: (reason: MediaClosed) => void): void {
    this.closedListeners.push(listener)
  }

  sendFrame(payload: Buffer, marker: boolean): void {
    const sender = this.transceiver?.sender
    if (this.closed || !this.mediaUp || sender === undefined) return
    this.sequence = (this.sequence + 1) & 0xffff
    this.timestamp = (this.timestamp + FRAME_SAMPLES) >>> 0
    const header = new RtpHeader({ payloadType: PCMU_PAYLOAD_TYPE, sequenceNumber: this.sequence, timestamp: this.timestamp, marker })
    void sender.sendRtp(new RtpPacket(header, payload)).catch(() => undefined)
  }

  sendControl(frame: string): boolean {
    if (this.closed || this.channel?.readyState !== 'open') return false
    this.channel.send(frame)
    return true
  }

  close(): void {
    this.finish('closed')
  }

  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, GATHER_TIMEOUT_MS)
      const subscription = this.pc.iceGatheringStateChange.subscribe((state) => { if (state === 'complete') done() })
      function done(): void {
        clearTimeout(timer)
        subscription.unSubscribe()
        resolve()
      }
    })
  }

  private adoptChannel(channel: RTCDataChannel): void {
    if (channel.label !== CONTROL_LABEL || this.channel !== undefined) return
    this.channel = channel
    channel.onMessage.subscribe((data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      for (const listener of this.controlListeners) listener(text)
    })
    channel.stateChanged.subscribe((state) => {
      if (state === 'open') this.maybeConnected()
      if (state === 'closed') this.finish('closed')
    })
    if (channel.readyState === 'open') this.maybeConnected()
  }

  private onConnectionState(state: string): void {
    if (state === 'connected') {
      if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
      this.graceTimer = undefined
      this.mediaUp = true
      this.maybeConnected()
    } else if (state === 'disconnected') {
      this.graceTimer ??= setTimeout(() => { this.finish('disconnected') }, this.network.disconnectGraceMs)
    } else if (state === 'failed') {
      this.finish('failed')
    } else if (state === 'closed') {
      this.finish('closed')
    }
  }

  private maybeConnected(): void {
    if (this.connected || !this.mediaUp || this.channel?.readyState !== 'open') return
    this.connected = true
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer)
    this.connectTimer = undefined
    for (const listener of this.connectedListeners) listener()
  }

  /** Decode PCMU and hand it on in 20 ms frames, whatever packet time the app chose. */
  private receive(rtp: RtpPacket): void {
    if (this.closed || rtp.header.payloadType !== PCMU_PAYLOAD_TYPE || rtp.payload.length === 0) return
    const samples = ulawDecode(rtp.payload)
    let offset = 0
    while (offset < samples.length) {
      const take = Math.min(FRAME_SAMPLES - this.pendingLength, samples.length - offset)
      this.pending.set(samples.subarray(offset, offset + take), this.pendingLength)
      this.pendingLength += take
      offset += take
      if (this.pendingLength === FRAME_SAMPLES) {
        const frame = this.pending.slice()
        this.pendingLength = 0
        for (const listener of this.audioListeners) listener(frame)
      }
    }
  }

  private finish(reason: MediaClosed): void {
    if (this.closed) return
    this.closed = true
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer)
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    void this.pc.close().catch(() => undefined)
    for (const listener of this.closedListeners) listener(reason)
  }
}
