/** The media seam of a call: one negotiated audio leg plus its control data channel. */

/** Why a media leg went away. */
export type MediaClosed = 'closed' | 'failed' | 'disconnected' | 'timeout'

/** One call's media, created per connect request and closed when the call ends. */
export interface CallMedia {
  /**
   * Answer the app's offer; resolves once the answer carries every local candidate.
   * @param offerSdp - the complete SDP offer.
   * @returns the complete SDP answer.
   * @throws when the offer has no usable audio or the negotiation failed.
   */
  answer(offerSdp: string): Promise<string>
  /** Subscribe to the owner's audio, one decoded 20 ms frame at 8 kHz per call. */
  onAudio(listener: (frame: Int16Array) => void): void
  /** Subscribe to control frames from the app. */
  onControl(listener: (frame: string) => void): void
  /** Subscribe to the moment media and control are both up. */
  onConnected(listener: () => void): void
  /** Subscribe to the end of the leg; called at most once. */
  onClosed(listener: (reason: MediaClosed) => void): void
  /**
   * Send one 20 ms PCMU frame.
   * @param payload - 160 μ-law bytes.
   * @param marker - first frame of a talk spurt.
   */
  sendFrame(payload: Buffer, marker: boolean): void
  /**
   * Send one control frame.
   * @param frame - JSON text.
   * @returns false when the channel is not open and the frame was dropped.
   */
  sendControl(frame: string): boolean
  /** Close the leg; idempotent. `onClosed` reports `closed`. */
  close(): void
}

/** Network settings of the media legs. */
export interface MediaNetwork {
  /** IPv4 address the UDP sockets bind to, e.g. the Tailscale address; undefined gathers every interface. */
  bindAddress: string | undefined
  /** Inclusive UDP port range, or undefined for any port. */
  portRange: [number, number] | undefined
  /** Also gather IPv6 candidates. */
  ipv6: boolean
  /** How long ICE and DTLS may take after the answer before the leg is closed as `timeout`, in milliseconds. */
  connectTimeoutMs: number
  /** How long a `disconnected` leg may stay so before it is closed, in milliseconds. */
  disconnectGraceMs: number
}

/** Creates the media leg of a call. */
export type MediaFactory = (network: MediaNetwork) => CallMedia
