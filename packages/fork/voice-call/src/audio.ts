/**
 * Telephone audio: G.711 μ-law (PCMU) frames, resampling between the call's 8 kHz and the speech
 * services' rates, and 16-bit WAV files. Everything works on mono `Int16Array` samples.
 */

/** Sample rate of a PCMU call leg. */
export const CALL_RATE = 8000
/** Samples in one 20 ms PCMU frame. */
export const FRAME_SAMPLES = 160
/** Frame length in milliseconds. */
export const FRAME_MS = 20
/** μ-law byte of digital silence. */
export const ULAW_SILENCE = 0xff

const ULAW_BIAS = 0x84
const ULAW_CLIP = 32_635

/**
 * Encode one linear sample as G.711 μ-law.
 * @param sample - signed 16-bit sample.
 * @returns the μ-law byte.
 */
export function ulawEncodeSample(sample: number): number {
  let value = Math.max(-32_768, Math.min(32_767, Math.round(sample)))
  const sign = value < 0 ? 0x80 : 0
  if (value < 0) value = -value
  value = Math.min(value, ULAW_CLIP) + ULAW_BIAS
  let exponent = 7
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1
  const mantissa = (value >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

/**
 * Decode one G.711 μ-law byte.
 * @param byte - the μ-law byte.
 * @returns the signed 16-bit sample.
 */
export function ulawDecodeSample(byte: number): number {
  const value = ~byte & 0xff
  const exponent = (value >> 4) & 0x07
  const magnitude = ((((value & 0x0f) << 3) + ULAW_BIAS) << exponent) - ULAW_BIAS
  return (value & 0x80) === 0 ? magnitude : -magnitude
}

const DECODE_TABLE = Int16Array.from({ length: 256 }, (_, byte) => ulawDecodeSample(byte))

/**
 * Encode linear samples as a PCMU payload.
 * @param samples - signed 16-bit samples.
 * @returns one μ-law byte per sample.
 */
export function ulawEncode(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length)
  /* v8 ignore next -- the index stays below samples.length, so `?? 0` only satisfies the index type. */
  for (let index = 0; index < samples.length; index += 1) out[index] = ulawEncodeSample(samples[index] ?? 0)
  return out
}

/**
 * Decode a PCMU payload.
 * @param payload - μ-law bytes.
 * @returns one signed 16-bit sample per byte.
 */
export function ulawDecode(payload: Uint8Array): Int16Array {
  const out = new Int16Array(payload.length)
  /* v8 ignore next -- the index stays below payload.length and DECODE_TABLE covers every byte, so both `??` only satisfy index types. */
  for (let index = 0; index < payload.length; index += 1) out[index] = DECODE_TABLE[payload[index] ?? ULAW_SILENCE] ?? 0
  return out
}

/** Half-width of the windowed-sinc kernel, in input samples at the lower of the two rates. */
const SINC_HALF_WIDTH = 8

/**
 * Change the sample rate with a Hann-windowed sinc kernel whose cut-off is half the lower rate, so a
 * downsampled signal is low-passed before it is decimated.
 * @param samples - mono 16-bit samples at `from` Hz.
 * @param from - input rate in Hz.
 * @param to - output rate in Hz.
 * @returns mono 16-bit samples at `to` Hz.
 */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || samples.length === 0) return samples.slice()
  const ratio = to / from
  const length = Math.max(1, Math.round(samples.length * ratio))
  const out = new Int16Array(length)
  // Cut-off relative to the input rate: 0.5 when upsampling, 0.5 * ratio when downsampling.
  const cutoff = Math.min(1, ratio) * 0.5
  const halfWidth = Math.ceil(SINC_HALF_WIDTH / Math.min(1, ratio))
  for (let index = 0; index < length; index += 1) {
    const center = index / ratio
    const first = Math.max(0, Math.ceil(center - halfWidth))
    const last = Math.min(samples.length - 1, Math.floor(center + halfWidth))
    let sum = 0
    let weights = 0
    for (let tap = first; tap <= last; tap += 1) {
      const distance = tap - center
      const x = 2 * cutoff * distance
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / (halfWidth + 1))
      const weight = sinc * window
      /* v8 ignore next -- tap stays within 0..samples.length - 1, so `?? 0` only satisfies the index type. */
      sum += (samples[tap] ?? 0) * weight
      weights += weight
    }
    /* v8 ignore next -- taps around any centre carry windowed-sinc weights summing to about 1; `weights === 0` only guards the division. */
    out[index] = Math.max(-32_768, Math.min(32_767, Math.round(weights === 0 ? 0 : sum / weights)))
  }
  return out
}

/** Mono audio at a known rate. */
export interface PcmAudio {
  /** Signed 16-bit samples. */
  readonly samples: Int16Array
  /** Sample rate in Hz. */
  readonly sampleRate: number
}

/** A WAV file this module cannot read. */
export class WavError extends Error {
  override readonly name = 'WavError'
}

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

/**
 * Read a RIFF WAVE file: integer PCM of 8, 16, 24, or 32 bits, or 32-bit float, any channel count
 * (mixed down to mono).
 * @param file - the whole file.
 * @returns its mono samples and rate.
 * @throws WavError when the file is not a WAV of those encodings.
 */
export function readWav(file: Uint8Array): PcmAudio {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...file.subarray(offset, offset + 4))
  if (file.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavError('not a RIFF WAVE file')
  let format: { code: number; channels: number; rate: number; bits: number } | undefined
  let data: Uint8Array | undefined
  for (let offset = 12; offset + 8 <= file.byteLength;) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    const end = Math.min(file.byteLength, body + size)
    if (id === 'fmt ' && size >= 16) {
      let code = view.getUint16(body, true)
      if (code === WAVE_FORMAT_EXTENSIBLE && size >= 26) code = view.getUint16(body + 24, true)
      format = {
        code, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      data = file.subarray(body, end)
    }
    offset = body + size + (size % 2)
  }
  if (format === undefined || data === undefined) throw new WavError('the WAV has no fmt or data chunk')
  const { code, channels, rate, bits } = format
  const supported = (code === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bits)) || (code === WAVE_FORMAT_FLOAT && bits === 32)
  if (!supported || channels < 1 || rate < 1000) throw new WavError(`unsupported WAV encoding (format ${code}, ${bits} bits, ${channels} channel(s), ${rate} Hz)`)
  const width = bits / 8
  const frames = Math.floor(data.byteLength / (width * channels))
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const sampleAt = (offset: number): number => {
    if (code === WAVE_FORMAT_FLOAT) return Math.max(-1, Math.min(1, dataView.getFloat32(offset, true))) * 32_767
    switch (bits) {
      case 8: return ((dataView.getUint8(offset)) - 128) << 8
      case 16: return dataView.getInt16(offset, true)
      case 24: return ((dataView.getUint8(offset + 2) << 24 | dataView.getUint8(offset + 1) << 16 | dataView.getUint8(offset) << 8) >> 16)
      default: return dataView.getInt32(offset, true) >> 16
    }
  }
  const samples = new Int16Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += sampleAt((frame * channels + channel) * width)
    samples[frame] = Math.max(-32_768, Math.min(32_767, Math.round(sum / channels)))
  }
  return { samples, sampleRate: rate }
}

/**
 * Write mono 16-bit PCM as a RIFF WAVE file.
 * @param audio - the samples and their rate.
 * @returns the whole file.
 */
export function writeWav(audio: PcmAudio): Buffer {
  const bytes = audio.samples.length * 2
  const out = Buffer.alloc(44 + bytes)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + bytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(WAVE_FORMAT_PCM, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(audio.sampleRate, 24)
  out.writeUInt32LE(audio.sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(bytes, 40)
  /* v8 ignore next -- the index stays below samples.length, so `?? 0` only satisfies the index type. */
  for (let index = 0; index < audio.samples.length; index += 1) out.writeInt16LE(audio.samples[index] ?? 0, 44 + index * 2)
  return out
}

/**
 * Root-mean-square level of a frame.
 * @param frame - signed 16-bit samples.
 * @returns the RMS amplitude, 0 to 32768.
 */
export function rms(frame: Int16Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return Math.sqrt(sum / frame.length)
}
