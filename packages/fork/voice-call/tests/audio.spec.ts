import { describe, expect, it } from 'vitest'
import {
  CALL_RATE,
  FRAME_MS,
  FRAME_SAMPLES,
  ULAW_SILENCE,
  WavError,
  readWav,
  resample,
  rms,
  ulawDecode,
  ulawDecodeSample,
  ulawEncode,
  ulawEncodeSample,
  writeWav,
} from '../src/audio.ts'

interface Chunk {
  id: string
  body: Buffer
  /** Size written in the header when it differs from the body length. */
  declaredSize?: number
}

/** A RIFF WAVE file from raw chunks, padded to even lengths as the format requires. */
function riff(chunks: Chunk[], form = 'WAVE'): Buffer {
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    const header = Buffer.alloc(8)
    header.write(chunk.id, 0, 'ascii')
    header.writeUInt32LE(chunk.declaredSize ?? chunk.body.length, 4)
    parts.push(header, chunk.body)
    if (chunk.body.length % 2 === 1) parts.push(Buffer.alloc(1))
  }
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + body.length, 4)
  head.write(form, 8, 'ascii')
  return Buffer.concat([head, body])
}

function fmt(code: number, channels: number, rate: number, bits: number, extensibleCode?: number): Chunk {
  const body = Buffer.alloc(extensibleCode === undefined ? 16 : 40)
  body.writeUInt16LE(code, 0)
  body.writeUInt16LE(channels, 2)
  body.writeUInt32LE(rate, 4)
  body.writeUInt32LE(rate * channels * bits / 8, 8)
  body.writeUInt16LE(channels * bits / 8, 12)
  body.writeUInt16LE(bits, 14)
  if (extensibleCode !== undefined) {
    body.writeUInt16LE(22, 16)
    body.writeUInt16LE(extensibleCode, 24)
  }
  return { id: 'fmt ', body }
}

describe('μ-law coding', () => {
  it('encodes silence as 0xff and decodes it back to zero', () => {
    expect(ulawEncodeSample(0)).toBe(ULAW_SILENCE)
    expect(ulawDecodeSample(ULAW_SILENCE)).toBe(0)
  })

  it('keeps the sign and clips samples beyond the 16-bit range', () => {
    expect(ulawDecodeSample(ulawEncodeSample(1000))).toBeGreaterThan(0)
    expect(ulawDecodeSample(ulawEncodeSample(-1000))).toBeLessThan(0)
    expect(ulawEncodeSample(100_000)).toBe(ulawEncodeSample(32_767))
    expect(ulawEncodeSample(-100_000)).toBe(ulawEncodeSample(-32_768))
    expect(ulawDecodeSample(ulawEncodeSample(32_767))).toBe(32_124)
    expect(ulawDecodeSample(ulawEncodeSample(-32_768))).toBe(-32_124)
  })

  it('round-trips every byte through decode and encode', () => {
    for (let byte = 0; byte < 256; byte += 1) {
      // 0x7f is negative zero; it re-encodes as positive zero.
      if (byte === 0x7f) continue
      expect(ulawEncodeSample(ulawDecodeSample(byte))).toBe(byte)
    }
  })

  it('stays within a few percent of the input level', () => {
    for (const sample of [-20_000, -3000, -50, 7, 120, 4000, 31_000]) {
      const decoded = ulawDecodeSample(ulawEncodeSample(sample))
      expect(Math.abs(decoded - sample)).toBeLessThanOrEqual(Math.max(8, Math.abs(sample) * 0.07))
    }
  })

  it('encodes and decodes whole payloads one byte per sample', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32_767, -32_768])
    const payload = ulawEncode(samples)
    expect(payload).toHaveLength(samples.length)
    expect(Array.from(ulawDecode(payload))).toEqual(Array.from(samples, sample => ulawDecodeSample(ulawEncodeSample(sample))))
    expect(ulawDecode(new Uint8Array(0))).toHaveLength(0)
  })

  it('describes a 20 ms frame at the call rate', () => {
    expect(FRAME_SAMPLES).toBe(CALL_RATE * FRAME_MS / 1000)
  })
})

describe('resampling', () => {
  it('returns a copy when the rates match or there is nothing to convert', () => {
    const samples = Int16Array.from([1, 2, 3])
    const same = resample(samples, 8000, 8000)
    expect(same).toEqual(samples)
    expect(same).not.toBe(samples)
    expect(resample(new Int16Array(0), 8000, 16_000)).toHaveLength(0)
  })

  it('scales the length by the rate ratio and keeps a constant level', () => {
    const flat = new Int16Array(800).fill(5000)
    const up = resample(flat, 8000, 16_000)
    expect(up).toHaveLength(1600)
    expect(up.every(sample => Math.abs(sample - 5000) <= 1)).toBe(true)
    const down = resample(flat, 8000, 4000)
    expect(down).toHaveLength(400)
    expect(down.every(sample => Math.abs(sample - 5000) <= 1)).toBe(true)
  })

  it('produces at least one sample from a very short input', () => {
    expect(resample(Int16Array.from([1000]), 48_000, 8000)).toHaveLength(1)
  })

  it('removes a tone above the new Nyquist frequency when downsampling', () => {
    // 3 kHz at 8 kHz, decimated to 4 kHz (Nyquist 2 kHz).
    const tone = Int16Array.from({ length: 800 }, (_, index) => Math.round(10_000 * Math.sin(2 * Math.PI * 3000 * index / 8000)))
    const down = resample(tone, 8000, 4000)
    expect(rms(down.subarray(20, 380))).toBeLessThan(rms(tone) * 0.2)
  })

  it('clamps an overshoot to the 16-bit range', () => {
    const square = Int16Array.from({ length: 400 }, (_, index) => (Math.floor(index / 4) % 2 === 0 ? 32_767 : -32_768))
    const up = resample(square, 8000, 44_100)
    expect(up.some(sample => sample === 32_767)).toBe(true)
    expect(up.some(sample => sample === -32_768)).toBe(true)
  })
})

describe('WAV files', () => {
  it('writes mono 16-bit PCM that reads back unchanged', () => {
    const samples = Int16Array.from([0, 1, -1, 32_767, -32_768, 1234])
    const file = writeWav({ samples, sampleRate: 16_000 })
    expect(file).toHaveLength(44 + samples.length * 2)
    expect(file.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(file.readUInt32LE(24)).toBe(16_000)
    const read = readWav(file)
    expect(read.sampleRate).toBe(16_000)
    expect(read.samples).toEqual(samples)
  })

  it('reads a WAV that sits inside a larger buffer', () => {
    const file = writeWav({ samples: Int16Array.from([7, -7]), sampleRate: 8000 })
    const outer = Buffer.concat([Buffer.alloc(3), file])
    expect(Array.from(readWav(outer.subarray(3)).samples)).toEqual([7, -7])
  })

  it('reads 8-bit, 24-bit, and 32-bit integer PCM', () => {
    const eight = riff([fmt(1, 1, 8000, 8), { id: 'data', body: Buffer.from([128, 255, 0]) }])
    expect(Array.from(readWav(eight).samples)).toEqual([0, 127 << 8, -128 << 8])

    const twentyFour = Buffer.alloc(6)
    twentyFour.writeIntLE(0x123456, 0, 3)
    twentyFour.writeIntLE(-0x123456, 3, 3)
    expect(Array.from(readWav(riff([fmt(1, 1, 8000, 24), { id: 'data', body: twentyFour }])).samples)).toEqual([0x1234, -0x1235])

    const thirtyTwo = Buffer.alloc(8)
    thirtyTwo.writeInt32LE(0x7fff0000, 0)
    thirtyTwo.writeInt32LE(-0x80000000, 4)
    expect(Array.from(readWav(riff([fmt(1, 1, 8000, 32), { id: 'data', body: thirtyTwo }])).samples)).toEqual([32_767, -32_768])
  })

  it('reads 32-bit float and clamps values beyond full scale', () => {
    const body = Buffer.alloc(12)
    body.writeFloatLE(0.5, 0)
    body.writeFloatLE(2, 4)
    body.writeFloatLE(-3, 8)
    expect(Array.from(readWav(riff([fmt(3, 1, 22_050, 32), { id: 'data', body }])).samples)).toEqual([16_384, 32_767, -32_767])
  })

  it('reads the sub-format of a WAVE_FORMAT_EXTENSIBLE header', () => {
    const body = Buffer.alloc(4)
    body.writeInt16LE(100, 0)
    body.writeInt16LE(-100, 2)
    expect(Array.from(readWav(riff([fmt(0xfffe, 1, 8000, 16, 1), { id: 'data', body }])).samples)).toEqual([100, -100])
  })

  it('refuses an extensible header too short to name its sub-format', () => {
    const short = fmt(0xfffe, 1, 8000, 16)
    expect(() => readWav(riff([short, { id: 'data', body: Buffer.alloc(4) }]))).toThrow(/format 65534/u)
  })

  it('mixes several channels down to mono', () => {
    const body = Buffer.alloc(8)
    body.writeInt16LE(1000, 0)
    body.writeInt16LE(3000, 2)
    body.writeInt16LE(-1000, 4)
    body.writeInt16LE(-2001, 6)
    const read = readWav(riff([fmt(1, 2, 44_100, 16), { id: 'data', body }]))
    expect(read.sampleRate).toBe(44_100)
    expect(Array.from(read.samples)).toEqual([2000, -1500])
  })

  it('skips unknown and odd-sized chunks and ignores a trailing partial frame', () => {
    const data = Buffer.alloc(5)
    data.writeInt16LE(10, 0)
    data.writeInt16LE(20, 2)
    const file = riff([{ id: 'LIST', body: Buffer.from('abc') }, fmt(1, 1, 8000, 16), { id: 'data', body: data }])
    expect(Array.from(readWav(file).samples)).toEqual([10, 20])
  })

  it('reads a data chunk whose declared size runs past the end of the file', () => {
    const body = Buffer.alloc(4)
    body.writeInt16LE(5, 0)
    body.writeInt16LE(6, 2)
    const file = riff([fmt(1, 1, 8000, 16), { id: 'data', body, declaredSize: 1000 }])
    expect(Array.from(readWav(file).samples)).toEqual([5, 6])
  })

  it('refuses files that are not RIFF WAVE', () => {
    expect(() => readWav(Buffer.from('RIFF'))).toThrow(WavError)
    expect(() => readWav(Buffer.from('RIFX\0\0\0\0WAVEfmt '))).toThrow('not a RIFF WAVE file')
    expect(() => readWav(riff([], 'AVI '))).toThrow('not a RIFF WAVE file')
  })

  it('refuses a WAV without a usable fmt or data chunk', () => {
    expect(() => readWav(riff([{ id: 'data', body: Buffer.alloc(2) }]))).toThrow('no fmt or data chunk')
    expect(() => readWav(riff([fmt(1, 1, 8000, 16)]))).toThrow('no fmt or data chunk')
    expect(() => readWav(riff([{ id: 'fmt ', body: Buffer.alloc(14) }, { id: 'data', body: Buffer.alloc(2) }]))).toThrow('no fmt or data chunk')
  })

  it('refuses encodings it cannot decode', () => {
    const data: Chunk = { id: 'data', body: Buffer.alloc(4) }
    const error = (() => {
      try {
        readWav(riff([fmt(1, 1, 8000, 12), data]))
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(WavError)
    expect(error).toHaveProperty('name', 'WavError')
    expect(() => readWav(riff([fmt(3, 1, 8000, 64), data]))).toThrow('unsupported WAV encoding (format 3, 64 bits')
    expect(() => readWav(riff([fmt(6, 1, 8000, 8), data]))).toThrow('format 6')
    expect(() => readWav(riff([fmt(1, 0, 8000, 16), data]))).toThrow('0 channel(s)')
    expect(() => readWav(riff([fmt(1, 1, 999, 16), data]))).toThrow('999 Hz')
  })
})

describe('frame level', () => {
  it('is zero for an empty or silent frame and the amplitude of a constant one', () => {
    expect(rms(new Int16Array(0))).toBe(0)
    expect(rms(new Int16Array(160))).toBe(0)
    expect(rms(new Int16Array(160).fill(-300))).toBe(300)
  })
})
