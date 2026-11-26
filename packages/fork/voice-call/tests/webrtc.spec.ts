import { describe, expect, it } from 'vitest'
import { RTCPeerConnection, RtpHeader, RtpPacket, type MediaStreamTrack } from 'werift'
import { FRAME_SAMPLES, ulawDecode, ulawEncode } from '../src/audio.ts'
import { createWebRtcMedia } from '../src/webrtc.ts'

const network = { bindAddress: '127.0.0.1', portRange: undefined, ipv6: false, connectTimeoutMs: 10_000, disconnectGraceMs: 1000 }

/** The app's side: an offerer with a sendrecv audio transceiver and the control channel, gathering on loopback. */
async function offerer(): Promise<{ pc: RTCPeerConnection; offer: string; send: (payload: Buffer) => void; received: Buffer[]; messages: string[]; channel: ReturnType<RTCPeerConnection['createDataChannel']> }> {
  const pc = new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false, iceUseIpv6: false, iceInterfaceAddresses: { udp4: '127.0.0.1' }, iceAdditionalHostAddresses: ['127.0.0.1'] })
  const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
  const received: Buffer[] = []
  const messages: string[] = []
  transceiver.onTrack.subscribe((track: MediaStreamTrack) => { track.onReceiveRtp.subscribe((rtp) => { received.push(rtp.payload) }) })
  const channel = pc.createDataChannel('control')
  channel.onMessage.subscribe((data) => { messages.push(typeof data === 'string' ? data : data.toString('utf8')) })
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') resolve()
    else pc.iceGatheringStateChange.subscribe((state) => { if (state === 'complete') resolve() })
  })
  let sequence = 1
  const send = (payload: Buffer): void => {
    sequence += 1
    const header = new RtpHeader({ payloadType: 0, sequenceNumber: sequence, timestamp: sequence * 160 })
    void transceiver.sender.sendRtp(new RtpPacket(header, payload))
  }
  return { pc, offer: pc.localDescription?.sdp ?? '', send, received, messages, channel }
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('the WebRTC media leg', () => {
  it('answers an offer with PCMU and every candidate, then carries audio both ways and control frames', async () => {
    const app = await offerer()
    const media = createWebRtcMedia(network)
    const frames: Int16Array[] = []
    const control: string[] = []
    let connected = false
    media.onAudio((frame) => { frames.push(frame) })
    media.onControl((frame) => { control.push(frame) })
    media.onConnected(() => { connected = true })
    const answer = await media.answer(app.offer)
    expect(answer).toMatch(/^m=audio \d+ UDP\/TLS\/RTP\/SAVPF 0\r?$/mu)
    expect(answer).toMatch(/^a=rtpmap:0 PCMU\/8000/mu)
    expect(answer).toMatch(/^a=candidate:.* 127\.0\.0\.1 /mu)
    await app.pc.setRemoteDescription({ type: 'answer', sdp: answer })
    await until(() => connected)

    const tone = Int16Array.from({ length: FRAME_SAMPLES }, (_, index) => Math.round(8000 * Math.sin(index / 3)))
    await until(() => {
      app.send(ulawEncode(tone))
      return frames.length > 0
    })
    expect(frames[0]).toHaveLength(FRAME_SAMPLES)
    expect(frames[0]).toEqual(ulawDecode(ulawEncode(tone)))

    await until(() => {
      media.sendFrame(ulawEncode(tone), false)
      return app.received.length > 0
    })
    expect(app.received[0]).toEqual(ulawEncode(tone))

    app.channel.send('{"v":1,"type":"interrupt"}')
    await until(() => control.length > 0)
    expect(control[0]).toBe('{"v":1,"type":"interrupt"}')
    expect(media.sendControl('{"v":1,"type":"stop-speaking"}')).toBe(true)
    await until(() => app.messages.length > 0)

    const closed: string[] = []
    media.onClosed((reason) => { closed.push(reason) })
    media.close()
    media.close()
    expect(closed).toEqual(['closed'])
    expect(media.sendControl('x')).toBe(false)
    await app.pc.close()
  }, 20_000)
})
