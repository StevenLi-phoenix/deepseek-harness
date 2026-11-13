import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeiyuTts, MacMiniTts } from '../src/tts.ts'
import { FakeVoiceHost } from './fake-voice.ts'

const host = new FakeVoiceHost()
let url = ''
beforeAll(async () => { url = await host.start() })
afterAll(async () => { await host.stop() })
beforeEach(() => {
  host.seen.length = 0
  host.failNext = {}
  host.feiyuStatuses = ['queued', 'running', 'success']
})

const call = { timeoutMs: 2000, retries: 1, retryDelayMs: 1, sleep: async () => {} }
const feiyu = (overrides: { key?: string | undefined; jobTimeoutMs?: number } = {}) => new FeiyuTts({
  baseUrl: `${url}/feiyu`, apiKey: async () => ('key' in overrides ? overrides.key : 'feiyu-key'), voice: 'feiyu', style: 'cute',
  jobTimeoutMs: overrides.jobTimeoutMs ?? 5000, pollMs: 1, call,
})

describe('FeiyuTts', () => {
  it('submits a job, polls until success, and returns the audio with the raw job JSON', async () => {
    const result = await feiyu().synthesize('你好')
    expect(result.audio.equals(host.audio)).toBe(true)
    expect(JSON.parse(result.raw!)).toMatchObject({ id: 'job1', status: 'success' })
    expect(JSON.parse(host.requests('/feiyu/v1/speech')[0]!.body.toString())).toEqual({ text: '你好', voice: 'feiyu', style: 'cute' })
    expect(host.requests('/feiyu/v1/jobs/job1')).toHaveLength(3)
    expect(host.seen.every(item => item.authorization === 'Bearer feiyu-key')).toBe(true)
  })

  it('refuses without a key and never calls the service', async () => {
    await expect(feiyu({ key: undefined }).synthesize('hi')).rejects.toThrow('API key is not configured')
    expect(host.seen).toHaveLength(0)
  })

  it('reports a rejected key as HTTP 401 without retrying', async () => {
    await expect(feiyu({ key: 'wrong' }).synthesize('hi')).rejects.toThrow('HTTP 401')
    expect(host.seen).toHaveLength(1)
  })

  it('rides out one 503 on submit', async () => {
    host.failNext.feiyu = [503]
    expect((await feiyu().synthesize('hi')).audio.byteLength).toBeGreaterThan(44)
    expect(host.requests('/feiyu/v1/speech')).toHaveLength(2)
  })

  it('fails when the job fails', async () => {
    host.feiyuStatuses = ['running', 'failed']
    await expect(feiyu().synthesize('hi')).rejects.toThrow('job1 failed')
  })

  it('gives up when the job outlives the deadline', async () => {
    host.feiyuStatuses = ['running']
    await expect(feiyu({ jobTimeoutMs: 30 }).synthesize('hi')).rejects.toThrow('still running after 30 ms')
  })
})

const hrefOf = (input: string | URL | Request): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
describe('FeiyuTts with a stubbed service', () => {
  const stubbed = (fetch: typeof globalThis.fetch) => new FeiyuTts({
    baseUrl: 'http://feiyu.test', apiKey: async () => 'k', voice: 'feiyu', style: 'cute', jobTimeoutMs: 5000, pollMs: 1, call: { ...call, fetch },
  })
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

  it('fails when the submit answer carries no job id', async () => {
    await expect(stubbed(async () => json({ status: 'queued' }, 202)).synthesize('hi')).rejects.toThrow('returned no job id')
  })

  it('fails when a job poll is not JSON', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      hrefOf(url).endsWith('/v1/speech') ? json({ id: 'job9' }, 202) : new Response('<html>', { status: 200 })
    ))
    await expect(stubbed(fetchMock).synthesize('hi')).rejects.toThrow('job9 returned a body that is not JSON')
  })

  it('fails when a finished job has empty audio', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = hrefOf(url)
      if (path.endsWith('/v1/speech')) return json({ id: 'job9' }, 202)
      if (path.endsWith('/audio')) return new Response(new Uint8Array(0))
      return json({ status: 'done' })
    })
    await expect(stubbed(fetchMock).synthesize('hi')).rejects.toThrow('job9 returned empty audio')
  })

  it('waits with the real timer between polls when no sleep is injected', async () => {
    const polls = ['running', 'done']
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = hrefOf(url)
      if (path.endsWith('/v1/speech')) return json({ id: 'job9' }, 202)
      if (path.endsWith('/audio')) return new Response(new Uint8Array([1, 2, 3]))
      return json({ status: polls.shift() })
    })
    const result = await new FeiyuTts({
      baseUrl: 'http://feiyu.test', apiKey: async () => 'k', voice: 'feiyu', style: 'cute', jobTimeoutMs: 5000, pollMs: 1,
      call: { timeoutMs: 1000, retries: 0, retryDelayMs: 1, fetch: fetchMock },
    }).synthesize('hi')
    expect([...result.audio]).toEqual([1, 2, 3])
    expect(polls).toEqual([])
  })
})

describe('MacMiniTts', () => {
  const mini = () => new MacMiniTts({ baseUrl: `${url}/mini`, speaker: 'vivian', language: 'Chinese', call })

  it('posts a multipart form and returns the WAV', async () => {
    const result = await mini().synthesize('你好')
    expect(result.audio.equals(host.audio)).toBe(true)
    const body = host.requests('/mini/synthesize')[0]!.body.toString()
    expect(body).toContain('name="text"')
    expect(body).toContain('vivian')
    expect(body).toContain('Chinese')
  })

  it('fails when the service answers an empty body', async () => {
    const tts = new MacMiniTts({ baseUrl: 'http://mini.test', speaker: 'vivian', language: 'Chinese', call: { ...call, fetch: async () => new Response(new Uint8Array(0)) } })
    await expect(tts.synthesize('hi')).rejects.toThrow('mac-mini POST /synthesize returned empty audio')
  })

  it('reports a service error', async () => {
    host.failNext.mini = [500, 500]
    await expect(mini().synthesize('hi')).rejects.toThrow('mac-mini POST /synthesize answered HTTP 500')
  })
})
