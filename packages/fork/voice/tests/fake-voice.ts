import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A tiny valid WAV: 16-bit mono at 8 kHz holding `ms` milliseconds of a square wave. */
export function wavBytes(ms = 200, tag = 0): Buffer {
  const samples = Math.floor(8 * ms)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) data.writeInt16LE(((i + tag) % 40 < 20 ? 8000 : -8000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** One recorded request. */
export interface Seen {
  method: string
  path: string
  authorization: string | undefined
  body: Buffer
}

/** A fake of the three voice services behind one loopback server, routed by path prefix. */
export class FakeVoiceHost {
  readonly seen: Seen[] = []
  /** Feiyu: statuses a job reports, in order, before the last one repeats. */
  feiyuStatuses: string[] = ['queued', 'running', 'success']
  /** Feiyu: key the server demands. */
  feiyuKey = 'feiyu-key'
  /** Statuses answered before the next request is allowed through, per route (`feiyu`, `mini`, `asr`). */
  failNext: Record<string, number[]> = {}
  /** What the ASR answers for the audio whose sha256 starts with the key; defaults to `fallbackTranscript`. */
  transcripts = new Map<string, string>()
  fallbackTranscript = '你好魔女大人'
  /** When set, the ASR answers this raw body instead of a transcript. */
  asrRaw: string | undefined
  /** Audio the TTS routes return. */
  audio = wavBytes(300, 1)
  private server: Server | undefined
  private polls = 0

  async start(): Promise<string> {
    this.server = createServer((request, response) => { void this.handle(request, response) })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server?.close(() => { resolve() }) })
  }

  requests(path: string): Seen[] {
    return this.seen.filter(item => item.path === path)
  }

  sha(audio: Buffer): string {
    return createHash('sha256').update(audio).digest('hex')
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    const path = (request.url ?? '').split('?')[0]!
    this.seen.push({ method: request.method ?? '', path, authorization: request.headers.authorization, body })
    const route = path.startsWith('/feiyu/') ? 'feiyu' : path.startsWith('/mini/') ? 'mini' : 'asr'
    const injected = this.failNext[route]?.shift()
    if (injected !== undefined) {
      response.writeHead(injected, { 'content-type': 'text/plain' }).end(`injected ${injected}`)
      return
    }
    if (route === 'feiyu') {
      this.feiyu(request, path, body, response)
    } else if (route === 'mini' && path === '/mini/synthesize') {
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(this.audio)
    } else if (path === '/asr/transcribe') {
      this.asr(body, response)
    } else {
      response.writeHead(404).end()
    }
  }

  private feiyu(request: IncomingMessage, path: string, body: Buffer, response: ServerResponse): void {
    if (request.headers.authorization !== `Bearer ${this.feiyuKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"A valid Bearer API key is required"}')
      return
    }
    const json = (status: number, value: unknown): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
    if (path === '/feiyu/v1/speech') {
      const parsed = JSON.parse(body.toString('utf8')) as { text?: string }
      if (typeof parsed.text !== 'string' || parsed.text === '') {
        json(422, { detail: 'text required' })
      } else {
        this.polls = 0
        json(202, { id: 'job1', kind: 'speech', status: 'queued' })
      }
    } else if (path === '/feiyu/v1/jobs/job1') {
      const status = this.feiyuStatuses[Math.min(this.polls++, this.feiyuStatuses.length - 1)]!
      json(200, { id: 'job1', status, audio: { seconds: 0.3 } })
    } else if (path === '/feiyu/v1/jobs/job1/audio') {
      response.writeHead(200, { 'content-type': 'audio/wav' }).end(this.audio)
    } else {
      response.writeHead(404).end()
    }
  }

  private asr(body: Buffer, response: ServerResponse): void {
    if (this.asrRaw !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(this.asrRaw)
      return
    }
    // The multipart body carries the file bytes verbatim; find the audio by its RIFF header.
    const start = body.indexOf(Buffer.from('RIFF'))
    const end = body.indexOf(Buffer.from('\r\n--'), start)
    const audio = start >= 0 ? body.subarray(start, end > start ? end : undefined) : Buffer.alloc(0)
    const sha = this.sha(audio)
    const text = [...this.transcripts].find(([prefix]) => sha.startsWith(prefix))?.[1] ?? this.fallbackTranscript
    const engine = /name="engine"\r\n\r\n(\w+)/.exec(body.toString('latin1'))?.[1] ?? 'funasr'
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      filename: 'x.wav', engine, duration_s: 0.3, segments: [{ text }], full_text: text, transcript: text,
    }))
  }
}
