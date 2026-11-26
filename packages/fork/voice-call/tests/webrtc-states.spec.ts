import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_SAMPLES, ulawDecode, ulawEncode } from '../src/audio.ts'
import type { MediaClosed, MediaNetwork } from '../src/media.ts'
import { CONTROL_LABEL, createWebRtcMedia } from '../src/webrtc.ts'

/** A stand-in for the parts of werift the media leg drives, so every connection state can be reached on demand. */
const fake = vi.hoisted(() => {
  class Emitter<T> {
    private listeners: Array<(value: T) => void> = []
    subscribe(listener: (value: T) => void): { unSubscribe: () => void } {
      this.listeners.push(listener)
      return { unSubscribe: () => { this.listeners = this.listeners.filter(each => each !== listener) } }
    }

    execute(value: T): void {
      for (const listener of [...this.listeners]) listener(value)
    }

    get size(): number {
      return this.listeners.length
    }
  }

  interface Packet {
    header: { payloadType: number; sequenceNumber?: number; timestamp?: number; marker?: boolean }
    payload: Buffer
  }

  class Channel {
    readonly onMessage = new Emitter<string | Buffer>()
    readonly stateChanged = new Emitter<string>()
    readonly sent: string[] = []
    constructor(readonly label: string, public readyState: string) {}

    send(frame: string): void {
      this.sent.push(frame)
    }

    setState(state: string): void {
      this.readyState = state
      this.stateChanged.execute(state)
    }
  }

  class Track {
    readonly onReceiveRtp = new Emitter<Packet>()
    constructor(readonly kind: string) {}
  }

  class Transceiver {
    direction = 'recvonly'
    readonly packets: Packet[] = []
    rejectSends = false
    readonly sender = {
      sendRtp: (packet: Packet): Promise<void> => {
        this.packets.push(packet)
        return this.rejectSends ? Promise.reject(new Error('socket gone')) : Promise.resolve()
      },
    }

    constructor(readonly kind: string) {}

    setDirection(direction: string): void {
      this.direction = direction
    }
  }

  class PeerConnection {
    static readonly made: PeerConnection[] = []
    readonly connectionStateChange = new Emitter<string>()
    readonly onDataChannel = new Emitter<Channel>()
    readonly onTrack = new Emitter<Track>()
    readonly iceGatheringStateChange = new Emitter<string>()
    iceGatheringState = 'new'
    localDescription: { type: string; sdp: string } | null = null
    remoteDescription: { type: string; sdp: string } | undefined
    transceivers: Transceiver[] = [new Transceiver('video'), new Transceiver('audio')]
    answerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\na=candidate:1 1 udp 2130706431 127.0.0.1 50000 typ host\r\n'
    dropLocalDescription = false
    /** Runs when the answer is applied; by default gathering is complete at once. */
    afterLocalDescription: (pc: PeerConnection) => void = (pc) => { pc.iceGatheringState = 'complete' }
    closeRejects = false
    closeCalls = 0

    constructor(readonly config: Record<string, unknown>) {
      PeerConnection.made.push(this)
    }

    setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
      this.remoteDescription = description
      return Promise.resolve()
    }

    getTransceivers(): Transceiver[] {
      return this.transceivers
    }

    createAnswer(): Promise<{ type: string; sdp: string }> {
      return Promise.resolve({ type: 'answer', sdp: this.answerSdp })
    }

    setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
      if (!this.dropLocalDescription) this.localDescription = description
      this.afterLocalDescription(this)
      return Promise.resolve()
    }

    close(): Promise<void> {
      this.closeCalls += 1
      return this.closeRejects ? Promise.reject(new Error('close failed')) : Promise.resolve()
    }

    audio(): Transceiver {
      const audio = this.transceivers.find(each => each.kind === 'audio')
      if (audio === undefined) throw new Error('no audio transceiver')
      return audio
    }
  }

  class Parameters {
    constructor(readonly init: Record<string, unknown>) {}
  }

  class RtpHeader {
    readonly payloadType: number
    readonly sequenceNumber: number
    readonly timestamp: number
    readonly marker: boolean
    constructor(init: { payloadType: number; sequenceNumber: number; timestamp: number; marker: boolean }) {
      this.payloadType = init.payloadType
      this.sequenceNumber = init.sequenceNumber
      this.timestamp = init.timestamp
      this.marker = init.marker
    }
  }

  class RtpPacket {
    constructor(readonly header: RtpHeader, readonly payload: Buffer) {}
  }

  return { Channel, PeerConnection, Track, Transceiver, Parameters, RtpHeader, RtpPacket }
})

vi.mock('werift', () => ({
  RTCPeerConnection: fake.PeerConnection,
  RTCRtpCodecParameters: fake.Parameters,
  RtpHeader: fake.RtpHeader,
  RtpPacket: fake.RtpPacket,
}))

const network: MediaNetwork = { bindAddress: undefined, portRange: undefined, ipv6: false, connectTimeoutMs: 3000, disconnectGraceMs: 1000 }
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n'

type PeerConnection = InstanceType<typeof fake.PeerConnection>
type Channel = InstanceType<typeof fake.Channel>

interface Leg {
  media: ReturnType<typeof createWebRtcMedia>
  pc: PeerConnection
  closed: MediaClosed[]
  connected: number[]
  frames: Int16Array[]
  control: string[]
}

function leg(overrides: Partial<MediaNetwork> = {}, prepare: (pc: PeerConnection) => void = () => undefined): Leg {
  const media = createWebRtcMedia({ ...network, ...overrides })
  const pc = fake.PeerConnection.made.at(-1)
  if (pc === undefined) throw new Error('no peer connection was made')
  prepare(pc)
  const result: Leg = { media, pc, closed: [], connected: [], frames: [], control: [] }
  media.onClosed((reason) => { result.closed.push(reason) })
  media.onConnected(() => { result.connected.push(Date.now()) })
  media.onAudio((frame) => { result.frames.push(frame) })
  media.onControl((frame) => { result.control.push(frame) })
  return result
}

function openChannel(pc: PeerConnection, label = CONTROL_LABEL, state = 'connecting'): Channel {
  const channel = new fake.Channel(label, state)
  pc.onDataChannel.execute(channel)
  return channel
}

/** Bring a leg to the connected state: answered, ICE connected, and the control channel open. */
async function connect(): Promise<Leg & { channel: Channel }> {
  const made = leg()
  await made.media.answer(offer)
  made.pc.connectionStateChange.execute('connected')
  const channel = openChannel(made.pc)
  channel.setState('open')
  return { ...made, channel }
}

function packet(payloadType: number, payload: Buffer): { header: { payloadType: number }; payload: Buffer } {
  return { header: { payloadType }, payload }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the WebRTC media leg, configured', () => {
  it('offers only PCMU and uses no STUN server', () => {
    const { pc } = leg({ ipv6: true })
    const codecs = pc.config.codecs
    expect(codecs).toEqual({ audio: [new fake.Parameters({ mimeType: 'audio/PCMU', clockRate: 8000, channels: 1, payloadType: 0 })], video: [] })
    expect(pc.config).toMatchObject({ iceServers: [], iceUseDefaultStunServer: false, iceUseIpv6: true })
    expect(pc.config).not.toHaveProperty('iceInterfaceAddresses')
    expect(pc.config).not.toHaveProperty('icePortRange')
  })

  it('binds to the configured address and port range', () => {
    const { pc } = leg({ bindAddress: '100.64.0.1', portRange: [40_000, 40_100] })
    expect(pc.config).toMatchObject({
      iceInterfaceAddresses: { udp4: '100.64.0.1' },
      iceAdditionalHostAddresses: ['100.64.0.1'],
      icePortRange: [40_000, 40_100],
    })
  })
})

describe('the WebRTC answer', () => {
  it('answers sendrecv on the audio transceiver with the gathered local description', async () => {
    const { media, pc } = leg()
    await expect(media.answer(offer)).resolves.toBe(pc.answerSdp)
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: offer })
    expect(pc.audio().direction).toBe('sendrecv')
    expect(pc.transceivers[0]?.direction).toBe('recvonly')
  })

  it('waits for ICE gathering to complete before answering', async () => {
    const { media, pc } = leg({}, (made) => {
      made.afterLocalDescription = () => {
        setTimeout(() => {
          made.iceGatheringStateChange.execute('gathering')
          made.iceGatheringStateChange.execute('complete')
        }, 300)
      }
    })
    let answered = false
    const answer = media.answer(offer).then((sdp) => { answered = true; return sdp })
    await vi.advanceTimersByTimeAsync(299)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe(pc.answerSdp)
    expect(pc.iceGatheringStateChange.size).toBe(0)
  })

  it('answers with what it has after five seconds of gathering', async () => {
    const { media, pc } = leg({}, (made) => { made.afterLocalDescription = () => undefined })
    let answered = false
    const answer = media.answer(offer).then((sdp) => { answered = true; return sdp })
    await vi.advanceTimersByTimeAsync(4999)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe(pc.answerSdp)
    expect(pc.iceGatheringStateChange.size).toBe(0)
  })

  it('refuses an offer without audio', async () => {
    const { media } = leg({}, (made) => { made.transceivers = [new fake.Transceiver('video')] })
    await expect(media.answer(offer)).rejects.toThrow('the offer has no audio')
  })

  it('fails when no local description exists after gathering', async () => {
    const { media } = leg({}, (made) => { made.dropLocalDescription = true })
    await expect(media.answer(offer)).rejects.toThrow('no local description after gathering')
  })

  it('fails when no local candidate was gathered', async () => {
    const { media } = leg({}, (made) => { made.answerSdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n' })
    await expect(media.answer(offer)).rejects.toThrow('no local ICE candidate was gathered; check ice.bindAddress')
  })

  it('refuses to answer once closed', async () => {
    const { media } = leg()
    media.close()
    await expect(media.answer(offer)).rejects.toThrow('the media leg is closed')
  })
})

describe('the WebRTC connection', () => {
  it('reports connected once ICE and the control channel are both up, in either order', async () => {
    const first = leg()
    await first.media.answer(offer)
    const channel = openChannel(first.pc)
    channel.setState('open')
    expect(first.connected).toHaveLength(0)
    first.pc.connectionStateChange.execute('connected')
    expect(first.connected).toHaveLength(1)
    first.pc.connectionStateChange.execute('connected')
    expect(first.connected).toHaveLength(1)

    const second = leg()
    await second.media.answer(offer)
    second.pc.connectionStateChange.execute('connected')
    expect(second.connected).toHaveLength(0)
    openChannel(second.pc, CONTROL_LABEL, 'open')
    expect(second.connected).toHaveLength(1)
  })

  it('may connect before the answer has gone out', () => {
    const { pc, connected, closed } = leg()
    pc.connectionStateChange.execute('connected')
    openChannel(pc, CONTROL_LABEL, 'open')
    expect(connected).toHaveLength(1)
    expect(closed).toEqual([])
  })

  it('closes as timeout when the connection does not come up in time', async () => {
    const { media, pc, closed } = leg()
    await media.answer(offer)
    pc.connectionStateChange.execute('connecting')
    await vi.advanceTimersByTimeAsync(2999)
    expect(closed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(closed).toEqual(['timeout'])
    expect(pc.closeCalls).toBe(1)
  })

  it('cancels the connect deadline once connected', async () => {
    const { closed } = await connect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(closed).toEqual([])
  })

  it('closes a disconnected leg after the grace period, counted from the first disconnect', async () => {
    const { pc, closed } = await connect()
    pc.connectionStateChange.execute('disconnected')
    await vi.advanceTimersByTimeAsync(600)
    pc.connectionStateChange.execute('disconnected')
    await vi.advanceTimersByTimeAsync(399)
    expect(closed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(closed).toEqual(['disconnected'])
  })

  it('keeps a leg that reconnects within the grace period', async () => {
    const { pc, closed, connected } = await connect()
    pc.connectionStateChange.execute('disconnected')
    await vi.advanceTimersByTimeAsync(500)
    pc.connectionStateChange.execute('connected')
    await vi.advanceTimersByTimeAsync(5000)
    expect(closed).toEqual([])
    expect(connected).toHaveLength(1)
  })

  it('closes as failed or closed when ICE says so', async () => {
    const failed = await connect()
    failed.pc.connectionStateChange.execute('failed')
    failed.pc.connectionStateChange.execute('closed')
    expect(failed.closed).toEqual(['failed'])

    const ended = await connect()
    ended.pc.connectionStateChange.execute('closed')
    expect(ended.closed).toEqual(['closed'])
  })

  it('closes when the control channel closes', async () => {
    const { channel, closed } = await connect()
    channel.setState('closing')
    expect(closed).toEqual([])
    channel.setState('closed')
    expect(closed).toEqual(['closed'])
  })

  it('closes once, cancelling pending timers, even when werift fails to close', async () => {
    const { media, pc, closed } = leg({}, (made) => { made.closeRejects = true })
    await media.answer(offer)
    pc.connectionStateChange.execute('disconnected')
    media.close()
    media.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(closed).toEqual(['closed'])
    expect(pc.closeCalls).toBe(1)
  })
})

describe('the control channel', () => {
  it('adopts only the first channel labelled control and passes its frames on as text', async () => {
    const { pc, control, media } = leg()
    await media.answer(offer)
    const other = openChannel(pc, 'chat', 'open')
    other.onMessage.execute('ignored')
    expect(media.sendControl('x')).toBe(false)
    const channel = openChannel(pc)
    const extra = openChannel(pc, CONTROL_LABEL, 'open')
    channel.onMessage.execute('{"v":1,"type":"speaking"}')
    channel.onMessage.execute(Buffer.from('{"v":1,"type":"hangup"}'))
    extra.onMessage.execute('also ignored')
    expect(control).toEqual(['{"v":1,"type":"speaking"}', '{"v":1,"type":"hangup"}'])
  })

  it('sends a frame only while the channel is open and the leg is up', async () => {
    const { media, pc } = leg()
    expect(media.sendControl('early')).toBe(false)
    const channel = openChannel(pc)
    expect(media.sendControl('connecting')).toBe(false)
    channel.setState('open')
    expect(media.sendControl('{"v":1,"type":"say","text":"hi"}')).toBe(true)
    expect(channel.sent).toEqual(['{"v":1,"type":"say","text":"hi"}'])
    media.close()
    expect(media.sendControl('late')).toBe(false)
    expect(channel.sent).toHaveLength(1)
  })
})

describe('outgoing audio', () => {
  it('drops frames until media is up, then sends PCMU packets with advancing sequence and timestamp', async () => {
    const { media, pc } = leg()
    const payload = ulawEncode(new Int16Array(FRAME_SAMPLES).fill(1000))
    media.sendFrame(payload, true)
    pc.connectionStateChange.execute('connected')
    media.sendFrame(payload, true)
    expect(pc.audio().packets).toHaveLength(0)
    await media.answer(offer)
    media.sendFrame(payload, true)
    media.sendFrame(payload, false)
    const [first, second] = pc.audio().packets
    expect(first?.payload).toBe(payload)
    expect(first?.header).toMatchObject({ payloadType: 0, marker: true })
    expect(second?.header).toMatchObject({ payloadType: 0, marker: false })
    expect(((second?.header.sequenceNumber ?? 0) - (first?.header.sequenceNumber ?? 0) + 0x10000) % 0x10000).toBe(1)
    expect(((second?.header.timestamp ?? 0) - (first?.header.timestamp ?? 0) + 0x1_0000_0000) % 0x1_0000_0000).toBe(FRAME_SAMPLES)
    media.close()
    media.sendFrame(payload, false)
    expect(pc.audio().packets).toHaveLength(2)
  })

  it('swallows a failed send', async () => {
    const { media, pc } = await connect()
    pc.audio().rejectSends = true
    media.sendFrame(Buffer.alloc(FRAME_SAMPLES, 0xff), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(pc.audio().packets).toHaveLength(1)
  })
})

describe('incoming audio', () => {
  it('listens to audio tracks only', () => {
    const { pc } = leg()
    const video = new fake.Track('video')
    const audio = new fake.Track('audio')
    pc.onTrack.execute(video)
    pc.onTrack.execute(audio)
    expect(video.onReceiveRtp.size).toBe(0)
    expect(audio.onReceiveRtp.size).toBe(1)
  })

  it('re-chunks PCMU packets of any length into 20 ms frames', () => {
    const { pc, frames } = leg()
    const track = new fake.Track('audio')
    pc.onTrack.execute(track)
    const samples = Int16Array.from({ length: 400 }, (_, index) => (index % 50) * 100)
    const payload = ulawEncode(samples)
    track.onReceiveRtp.execute(packet(0, payload))
    expect(frames).toHaveLength(2)
    track.onReceiveRtp.execute(packet(0, ulawEncode(new Int16Array(80).fill(-500))))
    expect(frames).toHaveLength(3)
    expect(frames.every(frame => frame.length === FRAME_SAMPLES)).toBe(true)
    const decoded = ulawDecode(payload)
    expect(Array.from(frames[0] ?? [])).toEqual(Array.from(decoded.subarray(0, 160)))
    expect(Array.from(frames[2]?.subarray(0, 80) ?? [])).toEqual(Array.from(decoded.subarray(320, 400)))
    expect(Array.from(frames[2]?.subarray(80) ?? [])).toEqual(Array.from(ulawDecode(ulawEncode(new Int16Array(80).fill(-500)))))
  })

  it('ignores packets that are not PCMU, empty packets, and packets after close', () => {
    const { pc, frames, media } = leg()
    const track = new fake.Track('audio')
    pc.onTrack.execute(track)
    track.onReceiveRtp.execute(packet(8, Buffer.alloc(160, 0xd5)))
    track.onReceiveRtp.execute(packet(0, Buffer.alloc(0)))
    expect(frames).toEqual([])
    media.close()
    track.onReceiveRtp.execute(packet(0, Buffer.alloc(160, 0xff)))
    expect(frames).toEqual([])
  })
})
