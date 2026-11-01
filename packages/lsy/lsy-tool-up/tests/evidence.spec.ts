import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolUp from '../src/index.ts'
import { BiliEvidenceRefusedError, CommentCache, commentsOf, loadSalt, senderKey } from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-tool-up-evidence-'))
  dirs.push(dir)
  return dir
}

const OWN = 100
const comment = (rpid: number, mid: number, text: string) => ({ rpid, mid, ctime: 1_761_955_200, untrusted: { text, uname: `u${mid}` } })

/** bili-svc double: `/v1/status`, `/v1/comments`, and the root thread of any rpid in it, like bili-svc's thread endpoint. */
function biliSvc(threads: Array<{ root: ReturnType<typeof comment>; replies: Array<ReturnType<typeof comment>> }> = []) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    const path = url.replace('http://127.0.0.1:8097', '')
    let body: unknown = { error: 'not_found' }
    let status = 404
    if (path === '/v1/status') [status, body] = [200, { accounts: [{ id: 'up', mid: OWN }, { id: 'maomao', mid: 101 }] }]
    else if (path.startsWith('/v1/comments?')) [status, body] = [200, { comments: [comment(1, 7, '红石好看'), comment(2, OWN, '谢谢')] }]
    else {
      const match = /^\/v1\/comments\/(\d+)\/thread/.exec(path)
      const rpid = Number(match?.[1])
      const thread = threads.find(candidate => [candidate.root, ...candidate.replies].some(item => item.rpid === rpid))
      if (thread !== undefined) [status, body] = [200, thread]
    }
    return new Response(JSON.stringify(body), { status })
  }))
  return urls
}

async function mount(options: { persistent?: string; callsPerTurn?: number } = {}) {
  const dir = await tmp()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('systemPrompt', { tools: () => () => {} } as never)
  ctx.provide('credentials', { resolve: async () => ({ value: 't' }) } as never)
  ctx.provide('lsyEventBus', { persistentSubscriptionOf: (id: string) => (id === (options.persistent ?? 'up-1') ? 'bili-digest' : undefined) } as never)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ToolUp, ToolUp.Config({ notes: { file: join(dir, 'notes.json') }, evidence: { saltFile: join(dir, 'salt') }, ...options.callsPerTurn === undefined ? {} : { callsPerTurn: options.callsPerTurn } } as never))
  const read = async (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal, calls: [{ type: 'tool-call', id: ToolCallId(`${name}-x`), name, arguments: JSON.stringify(args) }] })
  return { ctx, dir, read, evidence: ctx.biliEvidence }
}

describe('bili evidence verifier', () => {
  it('answers from the comments the Session read, with salted sender keys instead of UIDs, never the creator\'s own comments', async () => {
    const urls = biliSvc()
    const { read, evidence, dir } = await mount()
    await read('up_comments', {})
    const items = await evidence.evidenceOf(['1', '2', '1', 'x', '-3'], { sessionId: 'up-1' })
    const salt = (await readFile(join(dir, 'salt'), 'utf8')).trim()
    expect(items).toEqual([{ id: '1', senderKey: senderKey(salt, 7), at: 1_761_955_200_000, text: '红石好看' }])
    expect(items[0]!.senderKey).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(items)).not.toMatch(/"7"|:7[,}]/)
    // rpid 2 was read from the listing but belongs to the creator's own account.
    expect(urls.filter(url => url.includes('/thread'))).toEqual([])
    expect((await stat(join(dir, 'salt'))).mode & 0o777).toBe(0o600)
  })

  it('reads the existing thread endpoint for an id the Session did not read, and leaves out what it cannot find', async () => {
    const urls = biliSvc([{ root: comment(50, 8, '根评论'), replies: [comment(51, 9, '回复'), comment(52, OWN, '自己的回复')] }])
    const { evidence } = await mount()
    const items = await evidence.evidenceOf(['51', '52', '99'], { sessionId: 'up-1' })
    expect(urls.filter(url => url.includes('/thread'))).toEqual(['http://127.0.0.1:8097/v1/comments/51/thread', 'http://127.0.0.1:8097/v1/comments/99/thread'])
    expect(items.map(item => [item.id, item.text])).toEqual([['51', '回复']])
    // The thread read for 51 also cached its root and siblings; the creator's own reply is never evidence.
    const fromRoot = await evidence.evidenceOf(['50', '51', '52'], { sessionId: 'up-1' })
    expect(fromRoot.map(item => item.id)).toEqual(['50', '51'])
    expect(urls.filter(url => url.includes('/thread'))).toHaveLength(2)
  })

  it('keys a sender the same way across calls and differently under another salt', async () => {
    expect(senderKey('a'.repeat(64), 7)).toBe(senderKey('a'.repeat(64), 7))
    expect(senderKey('a'.repeat(64), 7)).not.toBe(senderKey('b'.repeat(64), 7))
    expect(senderKey('a'.repeat(64), 7)).not.toBe(senderKey('a'.repeat(64), 8))
    const file = join(await tmp(), 'deep', 'salt')
    const first = await loadSalt(file)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadSalt(file)).toBe(first)
  })

  it('refuses any Session but the persistent bili-digest one, and more than callsPerTurn calls a turn', async () => {
    biliSvc()
    const { ctx, evidence } = await mount({ callsPerTurn: 1 })
    await expect(evidence.evidenceOf(['1'], { sessionId: 'up-detached' })).rejects.toMatchObject({ name: 'BiliEvidenceRefusedError', code: 'not_persistent_session' })
    await evidence.evidenceOf(['1'], { sessionId: 'up-1' })
    const capped = evidence.evidenceOf(['1'], { sessionId: 'up-1' })
    await expect(capped).rejects.toBeInstanceOf(BiliEvidenceRefusedError)
    await expect(capped).rejects.toMatchObject({ code: 'turn_cap' })
    ;(ctx.emit as (...args: unknown[]) => void)('session/event', { id: 'up-1' }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })
    await expect(evidence.evidenceOf(['1'], { sessionId: 'up-1' })).resolves.toEqual([])
  })

  it('keeps nothing while the creator\'s own accounts are unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/v1/comments?') ? { comments: [comment(1, 7, 'x')] } : { error: 'down' }), { status: url.includes('/v1/comments?') ? 200 : 503 })))
    const { read, evidence } = await mount()
    await read('up_comments', {})
    expect(await evidence.evidenceOf(['1'], { sessionId: 'up-1' })).toEqual([])
  })

  it('parses only complete comments and bounds the cache', () => {
    expect(commentsOf({ comments: [comment(1, 2, 'a'), { rpid: 3 }], root: null, replies: 'x' })).toEqual([{ rpid: 1, mid: 2, ctime: 1_761_955_200, text: 'a' }])
    const cache = new CommentCache(2)
    cache.put(commentsOf({ comments: [comment(1, 2, 'a'), comment(2, 2, 'b'), comment(3, 2, 'c')] }))
    expect(cache.get(1)).toBeUndefined()
    expect(cache.get(3)?.text).toBe('c')
  })

  it('is exported for lsy-style as ctx.biliEvidence', async () => {
    biliSvc()
    const { ctx } = await mount()
    expect(typeof ctx.get('biliEvidence')?.evidenceOf).toBe('function')
    expect(ToolUp.name).toBe('lsy-tool-up')
  })
})
