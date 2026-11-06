import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { integrityNotice, scan, type Baseline, type TrustedSchedule } from '../src/compare.ts'
import { ABSENT, digestOf, scheduleState, type Target } from '../src/scan.ts'
import { lastHistorySha, readJson, sha256, writeJson } from '../src/files.ts'
import { NoticeGate } from '../src/scanner.ts'
import { countAnswer, mountSessionWatch, textOf, type TicCounts } from '../src/session-watch.ts'
import { mountScheduleTrust, trustedOf } from '../src/schedule-trust.ts'

const dirs: string[] = []
const contexts: Context[] = []
const run = promisify(execFile)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lsy-integrity-parts-'))
  dirs.push(dir)
  return dir
}

describe('NoticeGate', () => {
  const MINUTE = 60_000
  const noon = new Date('2026-11-02T12:00:00').getTime()

  it('lets the first notice go, then holds the next inside the minimum gap', () => {
    const gate = new NoticeGate(30 * MINUTE, 6)
    expect(gate.holdBack(noon)).toBeUndefined()
    gate.sent(noon)
    expect(gate.holdBack(noon + 10 * MINUTE)).toBe('minimum gap')
    expect(gate.holdBack(noon + 30 * MINUTE)).toBeUndefined()
  })

  it('stops at the daily limit whatever the gap, and starts a new day with a clean count', () => {
    const gate = new NoticeGate(0, 2)
    gate.sent(noon)
    gate.sent(noon + MINUTE)
    expect(gate.holdBack(noon + 2 * MINUTE)).toBe('daily limit')
    expect(gate.holdBack(noon + 24 * 60 * MINUTE)).toBeUndefined()
  })

  it('names the daily limit before the gap when both hold', () => {
    const gate = new NoticeGate(30 * MINUTE, 1)
    gate.sent(noon)
    expect(gate.holdBack(noon + MINUTE)).toBe('daily limit')
  })
})

describe('countAnswer', () => {
  it('counts answers, answers with a forbidden line, hits, and hits per line', () => {
    const counts: TicCounts = { days: {} }
    expect(countAnswer(counts, '2026-11-02', [])).toEqual({ answers: 1, answersWithHits: 0, hits: 0, perLine: {} })
    expect(countAnswer(counts, '2026-11-02', [3, 3, 7])).toEqual({ answers: 2, answersWithHits: 1, hits: 3, perLine: { 3: 2, 7: 1 } })
    expect(countAnswer(counts, '2026-11-03', [3]).answers).toBe(1)
    expect(Object.keys(counts.days)).toEqual(['2026-11-02', '2026-11-03'])
  })

  it('keeps the sixty most recent days', () => {
    const counts: TicCounts = { days: {} }
    for (let day = 1; day <= 65; day += 1) countAnswer(counts, `2026-${String(Math.ceil(day / 28)).padStart(2, '0')}-${String(((day - 1) % 28) + 1).padStart(2, '0')}`, [])
    const days = Object.keys(counts.days).toSorted()
    expect(days).toHaveLength(60)
    expect(days[0]).toBe('2026-01-06')
    expect(days.at(-1)).toBe('2026-03-09')
  })
})

describe('textOf', () => {
  it('joins the text blocks of a message and ignores the rest', () => {
    expect(textOf({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
    expect(textOf({ content: 'plain' })).toBe('')
    expect(textOf({})).toBe('')
  })
})

describe('state files', () => {
  it('writes JSON atomically at mode 600, creates the directory, and reads it back', async () => {
    const dir = await tmp()
    const path = join(dir, 'nested', 'state.json')
    await writeJson(path, { a: 1 })
    expect(await readJson(path)).toEqual({ a: 1 })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
  })

  it('reads a missing or torn file as undefined', async () => {
    const dir = await tmp()
    expect(await readJson(join(dir, 'none.json'))).toBeUndefined()
    await writeFile(join(dir, 'torn.json'), '{"a":')
    expect(await readJson(join(dir, 'torn.json'))).toBeUndefined()
  })

  it('takes the last sha of the memory history, skipping a torn line', async () => {
    const dir = await tmp()
    const memory = join(dir, 'memory.jsonl')
    expect(await lastHistorySha(memory)).toBeUndefined()
    await writeFile(join(dir, 'memory.history.jsonl'), `${JSON.stringify({ sha: 'aaa' })}\n${JSON.stringify({ sha: 'bbb' })}\n{"sha": \n\n`)
    expect(await lastHistorySha(memory)).toBe('bbb')
    await writeFile(join(dir, 'memory.history.jsonl'), '\n')
    expect(await lastHistorySha(memory)).toBeUndefined()
  })

  it('hashes with SHA-256 and stamps a trusted schedule state', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(trustedOf('d', undefined)).toMatchObject({ digest: 'd' })
    expect(trustedOf('d', undefined)).not.toHaveProperty('tasks')
    expect(trustedOf('d', { t: 'x' })).toMatchObject({ digest: 'd', tasks: { t: 'x' } })
  })
})

describe('digestOf', () => {
  const file = (path: string): Target => ({ name: 'f', label: 'f', kind: 'file', path })
  const dir = (path: string): Target => ({ name: 'd', label: 'd', kind: 'dir', path })

  it('hashes a file larger than 4 MiB by its size and mtime instead of reading it', async () => {
    const root = await tmp()
    const path = join(root, 'big.bin')
    await writeFile(path, '')
    await truncate(path, 4 * 1024 * 1024 + 1)
    const first = await digestOf(file(path))
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    await truncate(path, 4 * 1024 * 1024 + 2)
    expect(await digestOf(file(path))).not.toBe(first)
  })

  it('reads at most 2000 files of a directory, so later files do not move the digest', async () => {
    const root = await tmp()
    await mkdir(join(root, 'skills'))
    await Promise.all(Array.from({ length: 2001 }, async (_, index) => { await writeFile(join(root, 'skills', `f${String(index).padStart(4, '0')}`), 'x') }))
    const before = await digestOf(dir(join(root, 'skills')))
    await writeFile(join(root, 'skills', 'f2000'), 'changed after the limit')
    expect(await digestOf(dir(join(root, 'skills')))).toBe(before)
    await writeFile(join(root, 'skills', 'f0000'), 'changed inside the limit')
    expect(await digestOf(dir(join(root, 'skills')))).not.toBe(before)
  })

  it('skips node_modules and .git, and reads a dangling symlink as an unreadable file', async () => {
    const root = await tmp()
    await mkdir(join(root, 'skills', 'node_modules'), { recursive: true })
    await writeFile(join(root, 'skills', 'node_modules', 'x'), '1')
    const plain = await digestOf(dir(join(root, 'skills')))
    await writeFile(join(root, 'skills', 'node_modules', 'x'), '2')
    expect(await digestOf(dir(join(root, 'skills')))).toBe(plain)
    await symlink(join(root, 'nowhere'), join(root, 'skills', 'link'))
    const withLink = await digestOf(dir(join(root, 'skills')))
    expect(withLink).not.toBe(plain)
    await writeFile(join(root, 'nowhere'), 'now it exists')
    expect(await digestOf(dir(join(root, 'skills')))).not.toBe(withLink)
  })

  it('ignores entries that are neither files, links, nor directories', async () => {
    const root = await tmp()
    await mkdir(join(root, 'skills'))
    const empty = await digestOf(dir(join(root, 'skills')))
    await run('mkfifo', [join(root, 'skills', 'pipe')])
    expect(await digestOf(dir(join(root, 'skills')))).toBe(empty)
  })

  it('says unreadable when a directory target is a file or a file target is a directory', async () => {
    const root = await tmp()
    await writeFile(join(root, 'plain'), 'x')
    await mkdir(join(root, 'folder'))
    expect(await digestOf(dir(join(root, 'plain')))).toBe('unreadable')
    expect(await digestOf(file(join(root, 'folder')))).toBe('unreadable')
    expect(await digestOf(dir(join(root, 'missing')))).toBe(ABSENT)
  })
})

describe('scheduleState', () => {
  it('tells a missing file from an unreadable one', async () => {
    const root = await tmp()
    expect(await scheduleState(join(root, 'schedule.json'))).toEqual({ digest: ABSENT })
    await writeFile(join(root, 'schedule.json'), '{"tables":')
    expect(await scheduleState(join(root, 'schedule.json'))).toEqual({ digest: 'unreadable' })
  })

  it('reads a file without tasks as no tasks, and a task without a usable record by what it holds', async () => {
    const root = await tmp()
    const path = join(root, 'schedule.json')
    await writeFile(path, '{}')
    expect((await scheduleState(path)).tasks).toEqual({})
    const state = async (rows: Record<string, unknown>) => {
      await writeFile(path, JSON.stringify({ tables: { tasks: rows } }))
      return await scheduleState(path)
    }
    const odd = await state({ a: null, b: {}, c: { record: null }, d: { record: 'text' }, e: { record: ['x'] } })
    expect(Object.keys(odd.tasks ?? {})).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(odd.tasks?.['a']).toBe(odd.tasks?.['b'])
    expect(odd.tasks?.['b']).toBe(odd.tasks?.['c'])
    expect(odd.tasks?.['d']).not.toBe(odd.tasks?.['c'])
    const changed = await state({ a: null, b: {}, c: { record: null }, d: { record: 'other text' }, e: { record: ['x'] } })
    expect(changed.tasks?.['d']).not.toBe(odd.tasks?.['d'])
    expect(changed.tasks?.['e']).toBe(odd.tasks?.['e'])
  })
})

describe('scan', () => {
  const schedule = (path: string): Target => ({ name: 'schedule', label: '定时任务（定义）', kind: 'schedule', path })
  const note = (path: string): Target => ({ name: 'note', label: 'note', kind: 'file', path })

  it('reports nothing without a baseline and records every digest', async () => {
    const root = await tmp()
    await writeFile(join(root, 'n'), 'x')
    const found = await scan([note(join(root, 'n'))], undefined, join(root, 'memory.jsonl'))
    expect(found.changes).toEqual([])
    expect(found.digests['note']).toMatch(/^[0-9a-f]{64}$/u)
    expect(found.digests['memory']).toBe(ABSENT)
  })

  it('names a file that appeared, disappeared, or changed since the baseline', async () => {
    const root = await tmp()
    const path = join(root, 'n')
    const baseline = (digest: string): Baseline => ({ at: 'then', digests: { note: digest, memory: ABSENT } })
    expect((await scan([note(path)], baseline('abc'), join(root, 'm'))).changes).toEqual([{ target: 'note', label: 'note', kind: 'removed' }])
    await writeFile(path, 'x')
    expect((await scan([note(path)], baseline(ABSENT), join(root, 'm'))).changes).toEqual([{ target: 'note', label: 'note', kind: 'added' }])
    expect((await scan([note(path)], baseline('abc'), join(root, 'm'))).changes).toEqual([{ target: 'note', label: 'note', kind: 'changed' }])
  })

  it('reports a schedule file that appeared, without counts when it had no tasks before', async () => {
    const root = await tmp()
    const path = join(root, 'schedule.json')
    await writeFile(path, JSON.stringify({ tables: { tasks: { a: { record: { kind: 'daily', prompt: 'p' } } } } }))
    const baseline: Baseline = { at: 'then', digests: { schedule: ABSENT, memory: ABSENT } }
    const found = await scan([schedule(path)], baseline, join(root, 'm'))
    expect(found.changes).toEqual([{ target: 'schedule', label: '定时任务（定义）', kind: 'added' }])
    expect(found.scheduleTasks).toBeDefined()
  })

  it('reports a schedule file that disappeared, without counts, and keeps no task digests', async () => {
    const root = await tmp()
    const baseline: Baseline = { at: 'then', digests: { schedule: 'abc', memory: ABSENT }, scheduleTasks: { a: 'x' } }
    const found = await scan([schedule(join(root, 'schedule.json'))], baseline, join(root, 'm'))
    expect(found.changes).toEqual([{ target: 'schedule', label: '定时任务（定义）', kind: 'removed' }])
    expect(found.scheduleTasks).toBeUndefined()
  })

  it('counts against the trusted tasks when the service wrote a different state than the file now holds', async () => {
    const root = await tmp()
    const path = join(root, 'schedule.json')
    await writeFile(path, JSON.stringify({ tables: { tasks: { a: { record: { kind: 'daily', prompt: 'edited' } } } } }))
    const baseline: Baseline = { at: 'then', digests: { schedule: 'old', memory: ABSENT }, scheduleTasks: {} }
    const trusted: TrustedSchedule = { at: 'then', digest: 'other', tasks: { a: 'was', b: 'gone' } }
    const found = await scan([schedule(path)], baseline, join(root, 'm'), trusted)
    expect(found.changes).toEqual([{ target: 'schedule', label: '定时任务（定义）', kind: 'changed', counts: { added: 0, removed: 1, changed: 1 } }])
  })

  it('counts against the baseline tasks when nothing trusted is recorded', async () => {
    const root = await tmp()
    const path = join(root, 'schedule.json')
    await writeFile(path, JSON.stringify({ tables: { tasks: { a: { record: { kind: 'daily', prompt: 'edited' } } } } }))
    const baseline: Baseline = { at: 'then', digests: { schedule: 'old', memory: ABSENT }, scheduleTasks: { a: 'was' } }
    const found = await scan([schedule(path)], baseline, join(root, 'm'))
    expect(found.changes[0]).toMatchObject({ kind: 'changed', counts: { added: 0, removed: 0, changed: 1 } })
  })

  it('ignores a schedule file equal to the trusted state', async () => {
    const root = await tmp()
    const path = join(root, 'schedule.json')
    await writeFile(path, '{}')
    const state = await scheduleState(path)
    const found = await scan([schedule(path)], { at: 'then', digests: { schedule: 'old', memory: ABSENT } }, join(root, 'm'), { at: 'now', digest: state.digest })
    expect(found.changes).toEqual([])
  })
})

describe('integrityNotice with task counts among several changes', () => {
  it('shows the counts on the schedule line of a list', () => {
    const notice = integrityNotice([
      { target: 'schedule', label: '定时任务（定义）', kind: 'added', counts: { added: 2, removed: 0, changed: 0 } },
      { target: 'a', label: 'A', kind: 'removed' },
    ])
    expect(notice.body).toBe('· 定时任务文件被绕过 DSH 直接新建：新增 2 条、删除 0 条、修改 0 条\n· A：被删除')
  })
})

describe('mountScheduleTrust', () => {
  function fresh(): { ctx: Context; logs: string[] } {
    const ctx = new Context()
    contexts.push(ctx)
    const logs: string[] = []
    Object.assign(ctx.logger, {
      info: (format: string, ...args: unknown[]) => { logs.push(`info ${format} ${args.map(String).join(' ')}`) },
      warn: (format: string, ...args: unknown[]) => { logs.push(`warn ${format} ${args.map(String).join(' ')}`) },
    })
    return { ctx, logs }
  }

  it('listens to nothing when the schedule file is not watched', async () => {
    const { ctx, logs } = fresh()
    const trust = mountScheduleTrust(ctx, undefined, '/nonexistent-lsy-integrity/trusted.json')
    ctx.emit('schedule/changed')
    await trust.settled()
    expect(trust.version()).toBe(0)
    expect(logs).toEqual([])
  })

  it('records a missing schedule file as a trusted state with no tasks', async () => {
    const root = await tmp()
    const { ctx, logs } = fresh()
    const trust = mountScheduleTrust(ctx, { name: 'schedule', label: 's', kind: 'schedule', path: join(root, 'schedule.json') }, join(root, 'trusted.json'))
    ctx.emit('schedule/changed')
    await trust.settled()
    expect(trust.version()).toBe(1)
    expect(await import('../src/files.ts').then(files => files.readJson<TrustedSchedule>(join(root, 'trusted.json')))).toMatchObject({ digest: ABSENT })
    expect(logs.some(line => line.startsWith('info lsy-integrity: schedule written through the service: %d task(s)') && line.includes(' 0 '))).toBe(true)
  })

  it('keeps the last trusted state and warns when the file is unreadable right after a change', async () => {
    const root = await tmp()
    await writeFile(join(root, 'schedule.json'), '{"tables":')
    const { ctx, logs } = fresh()
    const trust = mountScheduleTrust(ctx, { name: 'schedule', label: 's', kind: 'schedule', path: join(root, 'schedule.json') }, join(root, 'trusted.json'))
    ctx.emit('schedule/changed')
    await trust.settled()
    expect(logs.some(line => line.startsWith('warn lsy-integrity: schedule file unreadable right after a schedule change'))).toBe(true)
    await expect(stat(join(root, 'trusted.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('warns and goes on when the trusted state cannot be written', async () => {
    const root = await tmp()
    await writeFile(join(root, 'blocker'), 'a file where a directory should be')
    const { ctx, logs } = fresh()
    const trust = mountScheduleTrust(ctx, { name: 'schedule', label: 's', kind: 'schedule', path: join(root, 'schedule.json') }, join(root, 'blocker', 'trusted.json'))
    ctx.emit('schedule/changed')
    await trust.settled()
    expect(logs.some(line => line.startsWith('warn lsy-integrity: recording the schedule state failed: %s EEXIST'))).toBe(true)
  })
})

describe('mountSessionWatch', () => {
  function watched(stateDir: string, presets: string[] = ['unattended']): { ctx: Context; logs: string[] } {
    const ctx = new Context()
    contexts.push(ctx)
    const logs: string[] = []
    Object.assign(ctx.logger, {
      info: (format: string, ...args: unknown[]) => { logs.push(`info ${format} ${args.map(String).join(' ')}`) },
      warn: (format: string, ...args: unknown[]) => { logs.push(`warn ${format} ${args.map(String).join(' ')}`) },
    })
    mountSessionWatch(ctx, stateDir, new Set(presets))
    return { ctx, logs }
  }

  const session = (id: string, preset?: string): Session => Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false,
    ...preset === undefined ? {} : { agentPreset: preset },
  })
  const answer = (text: string) => createAssistantMessage({ content: [{ type: 'text', text }], source: { kind: 'model', provider: 't', model: 't' } as never })
  const turnEnd = (ctx: Context, chat: Session): void => {
    ctx.emit('session/event', chat, { seq: chat.seq, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
  }

  it('hashes a system prompt of a Session with no preset under the name `unknown`', async () => {
    const root = await tmp()
    const { ctx, logs } = watched(root)
    const chat = session('anon')
    ctx.emit('session/event', chat, {
      type: 'system/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are the cat.' }] } },
    } as never)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('preset %s system prompt') && line.includes(' unknown '))).toBe(true) })
    await vi.waitFor(async () => {
      const stored = await import('../src/files.ts').then(files => files.readJson<Record<string, string>>(join(root, 'persona.json')))
      expect(Object.keys(stored ?? {})).toEqual(['unknown'])
    })
  })

  it('treats a text block without text as empty, so a prompt of such blocks carries no persona', async () => {
    const root = await tmp()
    const { ctx, logs } = watched(root)
    ctx.emit('session/event', session('blank', 'unattended'), {
      type: 'system/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text' }] } },
    } as never)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(logs.filter(line => line.includes('system prompt'))).toEqual([])
  })

  it('does not warn about a preset whose stored hash was written by an earlier run, and keeps the file when the hash is the same', async () => {
    const root = await tmp()
    const text = 'You are the cat.'
    const sha = sha256(text).slice(0, 12)
    await writeJson(join(root, 'persona.json'), { unattended: sha })
    const { ctx, logs } = watched(root)
    ctx.emit('session/event', session('known', 'unattended'), {
      type: 'system/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text }] } },
    } as never)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('system prompt sha256'))).toBe(true) })
    expect(logs.some(line => line.startsWith('warn'))).toBe(false)
  })

  it('goes on when the persona hashes cannot be written', async () => {
    const root = await tmp()
    await writeFile(join(root, 'blocker'), 'x')
    const { ctx, logs } = watched(join(root, 'blocker'))
    ctx.emit('session/event', session('nowrite', 'unattended'), {
      type: 'system/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are the cat.' }] } },
    } as never)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('system prompt sha256'))).toBe(true) })
  })

  it('adds an answer to the counts a previous run stored', async () => {
    const root = await tmp()
    const today = new Date().toISOString().slice(0, 10)
    await writeJson(join(root, 'tics.json'), { days: { [today]: { answers: 4, answersWithHits: 1, hits: 1, perLine: { 0: 1 } } } })
    const { ctx, logs } = watched(root)
    const chat = session('counting', 'unattended')
    chat.append('turn/start', { turn: 1 })
    chat.append('assistant/message', { turn: 1, step: 1, message: answer('今天天气不错') } as never, { surfaceOp: 'append' })
    turnEnd(ctx, chat)
    await vi.waitFor(() => { expect(logs.some(line => line.includes(`day ${today}: 1/5 answers`) || line.includes(`${today} 1 5`))).toBe(true) })
  })

  it('counts nothing for a turn that produced no answer, looking back past other events to the turn start', async () => {
    const root = await tmp()
    const { ctx, logs } = watched(root)
    const chat = session('silent', 'unattended')
    chat.append('turn/start', { turn: 1 })
    chat.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'r' } as never }), { surfaceOp: 'append' })
    turnEnd(ctx, chat)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(logs.filter(line => line.includes('tics session'))).toEqual([])
  })

  it('goes on when the counts cannot be written', async () => {
    const root = await tmp()
    await writeFile(join(root, 'blocker'), 'x')
    const { ctx, logs } = watched(join(root, 'blocker'))
    const chat = session('nowrite-tics', 'unattended')
    chat.append('turn/start', { turn: 1 })
    chat.append('assistant/message', { turn: 1, step: 1, message: answer('今天天气不错') } as never, { surfaceOp: 'append' })
    turnEnd(ctx, chat)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('tics session'))).toBe(true) })
  })
})
