/** The learner's files: schemas on read, owner-only atomic writes, the reply window, history, and raw answers. */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_STATE, type Exchange, type Rule } from '../src/records.ts'
import { freshId, LearningFileError, LearningStore, type ExchangeLimits } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function store(onFailure: (error: unknown) => void = () => undefined): Promise<LearningStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-notify-learning-store-'))
  roots.push(root)
  return new LearningStore(join(root, 'notify-learning'), onFailure)
}

const LIMITS: ExchangeLimits = { maxExchanges: 3, windowHours: 12, maxReplies: 2 }
const exchange = (id: string, at: string): Exchange => ({ id, session: 'wechat', at, trigger: 'scheduled', sent: '提醒：交作业', replies: [] })
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777
const rule: Rule = { id: 'r00000a', kind: 'CI', decision: 'silent', since: '2026-11-27T10:00:00Z', evidence: [{ exchange: 'x00000001', at: '2026-11-26T10:00:00Z', quote: '别发了' }] }

describe('freshId', () => {
  it('is a prefix and hex digits: eight for an exchange, six for a rule', () => {
    expect(freshId('x')).toMatch(/^x[0-9a-f]{8}$/u)
    expect(freshId('r')).toMatch(/^r[0-9a-f]{6}$/u)
    expect(freshId('x', 1)).toMatch(/^x[0-9a-f]{2}$/u)
  })
})

describe('LearningStore', () => {
  it('reads nothing learned before the first write', async () => {
    const s = await store()
    expect(await s.exchanges()).toEqual([])
    expect(await s.state()).toEqual(EMPTY_STATE)
  })

  it('keeps the newest maxExchanges exchanges in an owner-only file', async () => {
    const s = await store()
    for (const [index, at] of ['2026-11-27T01:00:00Z', '2026-11-27T02:00:00Z', '2026-11-27T03:00:00Z', '2026-11-27T04:00:00Z'].entries()) {
      await s.addExchange(exchange(`x0000000${String(index)}`, at), LIMITS)
    }
    expect((await s.exchanges()).map(item => item.id)).toEqual(['x00000001', 'x00000002', 'x00000003'])
    expect(await mode(s.dir)).toBe(0o700)
    expect(await mode(join(s.dir, 'exchanges.json'))).toBe(0o600)
  })

  it('attaches the owner\'s turn to each exchange still open for it', async () => {
    const s = await store()
    await s.addExchange(exchange('x00000001', '2026-11-26T10:00:00Z'), LIMITS)
    await s.addExchange(exchange('x00000002', '2026-11-27T08:00:00Z'), LIMITS)
    await s.addExchange(exchange('x00000003', '2026-11-27T12:00:00Z'), LIMITS)
    const reply = { at: '2026-11-27T09:00:00Z', owner: '这个别发了', agent: '好' }
    // The first is past its window, the third was sent after the reply.
    expect(await s.addReply(reply, LIMITS)).toBe(1)
    expect(await s.addReply({ ...reply, owner: '真的' }, LIMITS)).toBe(1)
    // The second already has maxReplies turns.
    expect(await s.addReply({ ...reply, owner: '第三次' }, LIMITS)).toBe(0)
    const byId = Object.fromEntries((await s.exchanges()).map(item => [item.id, item.replies.map(turn => turn.owner)]))
    expect(byId).toEqual({ x00000001: [], x00000002: ['这个别发了', '真的'], x00000003: [] })
  })

  it('writes nothing for a reply no exchange takes', async () => {
    const s = await store()
    expect(await s.addReply({ at: '2026-11-27T09:00:00Z', owner: '在吗', agent: '在' }, LIMITS)).toBe(0)
    await expect(readdir(s.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops on a file that is not JSON or not of its schema, naming the file', async () => {
    const s = await store()
    await mkdir(s.dir, { recursive: true })
    await writeFile(join(s.dir, 'rules.json'), '{"version":1,')
    await expect(s.state()).rejects.toThrow(LearningFileError)
    await expect(s.state()).rejects.toThrow(`${join(s.dir, 'rules.json')} is not valid JSON; fix or delete it`)
    await writeFile(join(s.dir, 'exchanges.json'), JSON.stringify({ version: 2, exchanges: [] }))
    await expect(s.exchanges()).rejects.toThrow(/exchanges\.json does not match its schema \(.+\); fix or delete it$/u)
  })

  it('passes on a read failure other than a missing file', async () => {
    const s = await store()
    await mkdir(join(s.dir, 'rules.json'), { recursive: true })
    await expect(s.state()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('writes the state, a history line, and the exchanges of one change, or nothing for undefined', async () => {
    const s = await store()
    await s.addExchange(exchange('x00000001', '2026-11-26T10:00:00Z'), LIMITS)
    await s.update((): undefined => undefined)
    await expect(stat(join(s.dir, 'rules.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const history = { at: '2026-11-27T10:00:00Z', revision: 1, by: 'nightly' as const, added: [rule], removed: [], model: 'mock/mock' }
    const result = await s.update((state, open) => {
      expect(open.map(item => item.id)).toEqual(['x00000001'])
      return { state: { ...state, revision: 1, rules: [rule] }, exchanges: [], history }
    })
    expect(result.state.revision).toBe(1)
    expect(await s.state()).toMatchObject({ revision: 1, rules: [rule] })
    expect(await s.exchanges()).toEqual([])
    expect((await readFile(join(s.dir, 'history.jsonl'), 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))).toEqual([history])
    expect(await mode(join(s.dir, 'history.jsonl'))).toBe(0o600)
    expect(await mode(join(s.dir, 'rules.json'))).toBe(0o600)

    // Without exchanges or history, only the state changes.
    await s.addExchange(exchange('x00000002', '2026-11-27T10:00:00Z'), LIMITS)
    await s.update(state => ({ state: { ...state, lastRunDay: '2026-11-27' } }))
    expect((await s.exchanges()).map(item => item.id)).toEqual(['x00000002'])
    expect((await readFile(join(s.dir, 'history.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('refuses a state its schema does not allow, before writing', async () => {
    const s = await store()
    await expect(s.update(state => ({ state: { ...state, revision: -1 } }))).rejects.toThrow()
    await expect(stat(join(s.dir, 'rules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the latest raw answers only, named by their time', async () => {
    const s = await store()
    for (const at of ['2026-11-25T10:00:00.000Z', '2026-11-26T10:00:00.000Z', '2026-11-27T10:00:00.000Z']) {
      await s.saveRaw(at, { text: at }, 2)
    }
    const files = await readdir(join(s.dir, 'raw'))
    expect(files.toSorted()).toEqual(['2026-11-26T10-00-00.000Z.json', '2026-11-27T10-00-00.000Z.json'])
    expect(JSON.parse(await readFile(join(s.dir, 'raw', files.toSorted()[1]!), 'utf8'))).toEqual({ text: '2026-11-27T10:00:00.000Z' })
    expect(await mode(join(s.dir, 'raw'))).toBe(0o700)
  })

  it('hands a tracked failure to onFailure and waits for tracked work on drain', async () => {
    const failures: unknown[] = []
    const s = await store(error => failures.push(error))
    let finished = false
    s.track(new Promise<void>((resolve) => { setTimeout(() => { finished = true; resolve() }, 5) }))
    s.track(Promise.reject(new Error('disk full')))
    await s.drain()
    expect(finished).toBe(true)
    expect(failures).toEqual([new Error('disk full')])
  })
})
