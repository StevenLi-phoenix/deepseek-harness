// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentActivity } from '../src/activity.ts'
import { zh } from '../src/client/locales.ts'
import {
  MAX_TREE_DEPTH, MAX_TREE_NODES, NO_COUNTS, catalogOf, classify, countStates, endReason, finishedLabel, formatClock, formatDuration,
  formatTokens, indexTree, metaParts, nowLine, rowsOf, summaryLine, totalOf,
  type PanelSources, type T,
} from '../src/client/model.ts'
import { SubagentPanel, type SubagentPanelProps } from '../src/client/SubagentPanel.tsx'
import { SubagentToggle, type SubagentToggleProps } from '../src/client/SubagentToggle.tsx'

const t = makeTranslate(zh) as T
const ROOT = 'session-root' as SessionId
const NOW = 1_000_000_000

const id = (value: string) => value as SessionId

function activity(partial: Partial<SubagentActivity>): SubagentActivity {
  return { phase: 'idle', since: NOW, at: NOW, step: 0, toolCalls: 0, ...partial }
}

/** A root with one running child (on a tool), one completed, one failed, and an external task. */
function sources(): PanelSources {
  const catalog = [
    { id: id('done'), createdAt: 1, mode: 'continuable', label: 'Resolve upstream merge conflicts', name: 'dsh-merge' },
    { id: id('run'), createdAt: 3, mode: 'continuable', label: 'Make DayTrail uploads resilient', name: 'daytrail-upload' },
    { id: id('fail'), createdAt: 2, mode: 'continuable', label: 'Check the CI run', name: 'ci-check' },
    { id: id('ext'), createdAt: 4, mode: 'external', label: 'Remote job' },
  ]
  const summary = (sid: string, running: boolean, values: Record<string, unknown>) => ({
    id: id(sid), displayTitle: sid, running, retainedBy: {}, blank: false, updatedAt: 0, origin: 'subagent', projectionValues: values,
  })
  return {
    projections: { [ROOT]: { state: 'ready', values: { subagentCatalog: catalog } } } as never,
    summaries: {
      done: summary('done', false, {
        subagentTiming: { settledMs: 125_000, lastTurnCompleted: true },
        tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
        subagentActivity: activity({ ended: 'completed', at: NOW - 50_000, note: { kind: 'text', text: '已解决 12 个冲突并推到 main' } }),
      }),
      run: summary('run', true, {
        subagentTiming: { settledMs: 0, active: { since: NOW - 780_000, through: NOW - 1_000 } },
        subagentActivity: activity({
          phase: 'tool', since: NOW - 8_000, at: NOW - 8_000, step: 34, toolCalls: 48,
          tool: { name: 'bash', preview: 'Find all point insert paths', open: 1 },
          note: { kind: 'thought', text: 'I have spent a lot; let me decide and implement.' },
        }),
      }),
      fail: summary('fail', false, {
        subagentTiming: { settledMs: 40_000 },
        subagentActivity: activity({ ended: 'error', error: 'UNKNOWN_MODEL', at: NOW - 10_000 }),
      }),
    } as never,
    statuses: new Map(),
  }
}

afterEach(() => { cleanup() })

describe('model', () => {
  it('puts running rows first and the finished ones by last activity, and classifies each', () => {
    const rows = rowsOf(sources(), ROOT, NOW)
    expect(rows.map(row => [row.id, row.state])).toEqual([
      ['run', 'running'], ['fail', 'failed'], ['done', 'done'], ['ext', 'external'],
    ])
    expect(rows[0]).toMatchObject({ title: 'Make DayTrail uploads resilient', name: 'daytrail-upload', durationMs: 780_000 })
    expect(rows[0]!.address).toEqual({ parentSessionId: ROOT, childSessionId: 'run', mode: 'continuable' })
    expect(rows[3]!.address).toBeUndefined()
    expect(summaryLine(countStates(rows), t)).toBe('1 个在跑 · 1 个完成 · 1 个出错 · 1 个外部任务')
  })

  it('classifies from the end kind, falling back to the timing projection', () => {
    expect(classify(true, activity({ ended: 'error' }), false)).toBe('running')
    expect(classify(false, activity({ ended: 'aborted' }), true)).toBe('stopped')
    expect(classify(false, undefined, true)).toBe('done')
    expect(classify(false, undefined, undefined)).toBe('idle')
    expect(endReason({ state: 'stopped', activity: activity({ ended: 'interrupted' }) } as never, t)).toBe('服务重启时中断')
  })

  it('says what a running child waits on, and marks a long wait', () => {
    expect(nowLine(activity({ phase: 'model', since: NOW - 30_000 }), NOW, t)).toMatchObject({ label: '模型思考中', elapsed: '已 30 秒', stalled: false })
    expect(nowLine(activity({ phase: 'model', since: NOW - 6 * 60_000 }), NOW, t).stalled).toBe(true)
    expect(nowLine(activity({ phase: 'tool', since: NOW - 60_000, tool: { name: 'bash', preview: 'swift test', open: 3 } }), NOW, t))
      .toMatchObject({ label: '正在执行 bash 等 2 个工具', detail: 'swift test', stalled: false })
    expect(nowLine(activity({ phase: 'retry', retry: { attempt: 2, max: 5, reason: 'Stream ended' } }), NOW, t))
      .toMatchObject({ label: '模型请求失败，第 2/5 次重试', detail: 'Stream ended', retrying: true })
    expect(nowLine(undefined, NOW, t).label).toBe('等待开始')
  })

  it('labels a finished row with its state and when it ended, the date only when not today', () => {
    const at = new Date(2026, 10, 11, 11, 43).getTime()
    const now = new Date(2026, 10, 11, 12, 44).getTime()
    expect(formatClock(at, now)).toBe('11:43')
    expect(formatClock(new Date(2026, 10, 10, 18, 54).getTime(), now)).toBe('11/10 18:54')
    expect(finishedLabel({ state: 'done', activity: activity({ phase: 'idle', since: at, ended: 'completed' }) } as never, now, t)).toBe('完成 11:43')
    expect(finishedLabel({ state: 'failed', activity: activity({ phase: 'idle', since: at, ended: 'error' }) } as never, now, t)).toBe('出错 11:43')
    expect(finishedLabel({ state: 'done' } as never, now, t)).toBe('完成')
  })

  it('formats durations and tokens', () => {
    expect(formatDuration(5_000, t)).toBe('5 秒')
    expect(formatDuration(782_000, t)).toBe('13 分 02 秒')
    expect(formatDuration(3_725_000, t)).toBe('1 小时 02 分')
    expect(formatTokens(999, t)).toBe('999 tok')
    expect(formatTokens(3_200_000, t)).toBe('3.2M tok')
  })
})

function hooks(source: PanelSources) {
  const state = { projectionsBySession: source.projections, byId: source.summaries }
  return {
    useSessions: ((selector: (value: typeof state) => unknown) => selector(state)) as never,
    useSessionStatus: ((selector: (value: PanelSources['statuses']) => unknown) => selector(source.statuses)) as never,
  }
}

describe('SubagentPanel', () => {
  it('reads the catalog, shows the running card with what it does now, and opens a child aside or in the main view', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const prepare = vi.fn()
    const openAside = vi.fn()
    const openMain = vi.fn()
    const props = { sessionId: ROOT, ...hooks(sources()), prepare, openAside, openMain, t } as unknown as SubagentPanelProps
    render(<SubagentPanel {...props} />)
    expect(prepare).toHaveBeenCalledWith(ROOT)
    expect(screen.getByText('1 个在跑 · 1 个完成 · 1 个出错 · 1 个外部任务')).toBeTruthy()
    expect(screen.getByRole('region', { name: '正在运行' }).textContent).toContain('正在执行 bash')
    expect(screen.getByText('Find all point insert paths')).toBeTruthy()
    expect(screen.getByText('daytrail-upload · 第 34 步 · 48 次工具')).toBeTruthy()
    expect(screen.getByText('在想：I have spent a lot; let me decide and implement.')).toBeTruthy()
    expect(screen.getByText('UNKNOWN_MODEL')).toBeTruthy()
    // Every finished row says it is finished, with a grey check for completed rather than a green dot.
    expect(screen.getByRole('heading', { name: '已结束 · 3' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '正在运行 · 1' })).toBeTruthy()
    const done = screen.getByText('已解决 12 个冲突并推到 main').closest('li')!
    expect(done.querySelector('[data-mark="done"]')).not.toBeNull()
    expect(done.querySelector('[data-state="done"]')).toBeNull()
    expect(done.textContent).toMatch(/^Resolve upstream merge conflicts.*完成 \d{2}:\d{2} · dsh-merge/)
    expect(screen.getByText('已解决 12 个冲突并推到 main')).toBeTruthy()
    expect(screen.getByText('13 分 00 秒')).toBeTruthy()
    expect(screen.getByText('3.2M tok')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Make DayTrail uploads resilient/ }))
    expect(openAside).toHaveBeenCalledWith({ parentSessionId: ROOT, childSessionId: 'run', mode: 'continuable' })
    fireEvent.click(screen.getByRole('button', { name: '在主区打开 Check the CI run' }))
    expect(openMain).toHaveBeenCalledWith({ parentSessionId: ROOT, childSessionId: 'fail', mode: 'continuable' })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Remote job/ }).disabled).toBe(true)
    vi.useRealTimers()
  })

  it('says so when the Session has no subagents', () => {
    const empty: PanelSources = { projections: { [ROOT]: { state: 'ready', values: { subagentCatalog: [] } } } as never, summaries: {}, statuses: new Map() }
    const actions = { prepare: vi.fn(), openAside: vi.fn(), openMain: vi.fn() }
    const props = { sessionId: ROOT, ...hooks(empty), ...actions, t } as unknown as SubagentPanelProps
    render(<SubagentPanel {...props} />)
    expect(screen.getByRole('status').textContent).toBe('这个会话还没有派出子智能体。')
  })
})

describe('SubagentToggle', () => {
  function mount(source: PanelSources, child = false) {
    const toggle = vi.fn()
    const props = {
      sessionId: ROOT, ...hooks(source), toggle, t,
      useSession: ((selector: (value: { subagent: unknown }) => unknown) => selector({ subagent: child ? {} : null })) as never,
    } as unknown as SubagentToggleProps
    render(<SubagentToggle {...props} />)
    return toggle
  }

  it('says how many run and opens the page on click, with no menu', () => {
    const toggle = mount(sources())
    const button = screen.getByRole('button', { name: '子智能体：1 个在跑，共 4 个。在右侧栏查看' })
    expect(button.textContent).toBe('1 个在跑')
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledWith(ROOT)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the total when none runs, and nothing without subagents or on a child Session', () => {
    const idle = sources()
    ;(idle.summaries as Record<string, { running: boolean }>).run!.running = false
    mount(idle)
    expect(screen.getByRole('button', { name: '子智能体：共 4 个，都没在跑。在右侧栏查看' }).textContent).toBe('4 个已结束')
    cleanup()
    mount({ projections: {}, summaries: {}, statuses: new Map() })
    expect(screen.queryByRole('button')).toBeNull()
    mount(sources(), true)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

/**
 * A nested tree: the root's only child `lead` has finished, but one of the two it started (`worker`)
 * still runs; `worker` started `deep`, which is done.
 *
 *   root → lead (done) → worker (running) → deep (done)
 *                      → scout (done)
 */
function nested(): PanelSources {
  const entry = (sid: string, createdAt: number, label: string) => ({ id: id(sid), createdAt, mode: 'continuable', label, name: sid })
  const summary = (sid: string, running: boolean, values: Record<string, unknown>) => ({
    id: id(sid), displayTitle: sid, running, retainedBy: {}, blank: false, updatedAt: 0, origin: 'subagent', projectionValues: values,
  })
  const done = (at: number) => ({ subagentTiming: { settledMs: 60_000, lastTurnCompleted: true }, subagentActivity: activity({ ended: 'completed', at }) })
  return {
    projections: {
      [ROOT]: { state: 'ready', values: { subagentCatalog: [entry('lead', 1, 'Coordinate the release')] } },
      lead: { state: 'idle', values: { subagentCatalog: [entry('scout', 2, 'Survey the changes'), entry('worker', 3, 'Build the bundle')] } },
      worker: { state: 'idle', values: { subagentCatalog: [entry('deep', 4, 'Check one file')] } },
    } as never,
    summaries: {
      lead: summary('lead', false, done(NOW - 120_000)),
      scout: summary('scout', false, done(NOW - 90_000)),
      worker: summary('worker', true, {
        subagentTiming: { settledMs: 0, active: { since: NOW - 30_000, through: NOW - 1_000 } },
        subagentActivity: activity({ phase: 'tool', since: NOW - 8_000, at: NOW - 8_000, step: 3, toolCalls: 2, tool: { name: 'bash', preview: '', open: 1 } }),
      }),
      deep: summary('deep', false, done(NOW - 20_000)),
    } as never,
    statuses: new Map(),
  }
}

describe('nested subagents', () => {
  it('counts the whole tree per Session, and puts a finished row with a running descendant with the live ones', () => {
    const source = nested()
    const index = indexTree(source, ROOT)
    expect(index.truncated).toBe(false)
    expect(index.below.get(ROOT)).toMatchObject({ running: 1, done: 3 })
    expect(totalOf(index.below.get(ROOT)!)).toBe(4)
    expect(index.below.get(id('lead'))).toMatchObject({ running: 1, done: 2 })
    expect(index.below.get(id('worker'))).toMatchObject({ running: 0, done: 1 })
    const [lead] = rowsOf(source, ROOT, NOW, index)
    expect(lead).toMatchObject({ id: 'lead', state: 'done', children: 2, below: { running: 1, done: 2 } })
    expect(rowsOf(source, id('lead'), NOW, index).map(row => row.id)).toEqual(['worker', 'scout'])
  })

  it('counts a Session met twice once, and stops at the depth bound', () => {
    const loop: PanelSources = {
      projections: {
        [ROOT]: { state: 'ready', values: { subagentCatalog: [{ id: id('a'), createdAt: 1, mode: 'oneshot', label: 'a' }] } },
        a: { state: 'ready', values: { subagentCatalog: [{ id: id('b'), createdAt: 2, mode: 'oneshot', label: 'b' }] } },
        b: { state: 'ready', values: { subagentCatalog: [{ id: id('a'), createdAt: 3, mode: 'oneshot', label: 'a' }, { id: ROOT, createdAt: 4, mode: 'oneshot', label: 'r' }] } },
      } as never,
      summaries: {},
      statuses: new Map(),
    }
    expect(totalOf(indexTree(loop, ROOT).below.get(ROOT)!)).toBe(2)

    const chain = Array.from({ length: MAX_TREE_DEPTH + 3 }, (_, n) => [n === 0 ? ROOT : `c${n}`, `c${n + 1}`] as const)
    const deep: PanelSources = {
      projections: Object.fromEntries(chain.map(([parent, child]) => [parent, {
        state: 'ready', values: { subagentCatalog: [{ id: id(child), createdAt: 1, mode: 'oneshot', label: child }] },
      }])) as never,
      summaries: {},
      statuses: new Map(),
    }
    const index = indexTree(deep, ROOT)
    expect(index.truncated).toBe(true)
    expect(totalOf(index.below.get(ROOT)!)).toBe(MAX_TREE_DEPTH)
  })

  it('opens a branch with running work by itself, reads it, keeps the clock going, and lets the viewer close it', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const prepare = vi.fn()
    const actions = { prepare, openAside: vi.fn(), openMain: vi.fn() }
    const props = { sessionId: ROOT, ...hooks(nested()), ...actions, t } as unknown as SubagentPanelProps
    render(<SubagentPanel {...props} />)
    expect(screen.getByText('1 个在跑 · 3 个完成')).toBeTruthy()
    const running = screen.getByRole('region', { name: '正在运行' })
    expect(screen.getByRole('heading', { name: '正在运行 · 1' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '已结束' })).toBeNull()
    // The finished lead still says it finished; the running worker under it shows what it does.
    expect(running.textContent).toMatch(/Coordinate the release.*完成 \d{2}:\d{2}/)
    expect(running.textContent).toContain('Build the bundle')
    expect(screen.getByText('已 8 秒')).toBeTruthy()
    expect(prepare).toHaveBeenCalledWith(ROOT)
    expect(prepare).toHaveBeenCalledWith('lead')
    // Only a nested Session runs, and the clock still ticks.
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText('已 10 秒')).toBeTruthy()
    // The worker's own finished child stays closed.
    expect(screen.getByRole('button', { name: '展开 1 个下级子智能体' })).toBeTruthy()
    expect(screen.queryByText('Check one file')).toBeNull()

    const branch = screen.getByRole('button', { name: '收起下级子智能体 · 1 个在跑' })
    expect(branch.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(branch)
    expect(screen.queryByText('Build the bundle')).toBeNull()
    const closed = screen.getByRole('button', { name: /^展开 2 个下级子智能体/ })
    expect(closed.textContent).toBe('展开 2 个下级子智能体1 个在跑')
    expect(closed.hasAttribute('data-running-below')).toBe(true)
    fireEvent.click(closed)
    expect(screen.getByText('Build the bundle')).toBeTruthy()
    vi.useRealTimers()
  })

  it('counts nested subagents in the header', () => {
    const props = {
      sessionId: ROOT, ...hooks(nested()), toggle: vi.fn(), t,
      useSession: ((selector: (value: { subagent: unknown }) => unknown) => selector({ subagent: null })) as never,
    } as unknown as SubagentToggleProps
    render(<SubagentToggle {...props} />)
    expect(screen.getByRole('button', { name: '子智能体：1 个在跑，共 4 个。在右侧栏查看' }).textContent).toBe('1 个在跑')
  })
})

/** A root whose catalog holds the given entries, with the given summaries. */
function tree(entries: readonly Record<string, unknown>[], summaries: Record<string, unknown> = {}): PanelSources {
  return {
    projections: { [ROOT]: { state: 'ready', values: { subagentCatalog: entries } } } as never,
    summaries: summaries as never,
    statuses: new Map(),
  }
}

describe('model edges', () => {
  it('knows when a catalog is unread, loading, failed, or read empty', () => {
    const at = (snapshot: unknown) =>
      catalogOf({ projections: { [ROOT]: snapshot } as never, summaries: {}, statuses: new Map() }, ROOT).state
    expect(catalogOf({ projections: {}, summaries: {}, statuses: new Map() }, ROOT)).toEqual({ entries: [], state: 'idle' })
    expect(at({ state: 'loading', values: {} })).toBe('loading')
    expect(at({ state: 'error', values: {} })).toBe('error')
    expect(at({ state: 'ready', values: {} })).toBe('ready')
    expect(at({ state: 'idle', values: {} })).toBe('idle')
  })

  it('titles a row from its label, its Session title, its name, or its id, and orders running rows newest first', () => {
    const rows = rowsOf(tree([
      { id: id('labelled'), createdAt: 1, mode: 'continuable', label: 'same', name: 'same' },
      { id: id('titled'), createdAt: 2, mode: 'oneshot', label: '' },
      { id: id('bare'), createdAt: 3, mode: 'oneshot' },
      { id: id('named'), createdAt: 4, mode: 'continuable', label: '', name: 'worker' },
      { id: id('old'), createdAt: 5, mode: 'oneshot', label: 'old run' },
      { id: id('new'), createdAt: 6, mode: 'oneshot', label: 'new run' },
    ], {
      titled: { id: id('titled'), running: false, title: 'From the title', projectionValues: { subagentTiming: { settledMs: 5_000, active: { since: NOW - 9_000, through: NOW - 4_000 } } } },
      old: { id: id('old'), running: true },
      new: { id: id('new'), running: true },
    }), ROOT, NOW)
    expect(rows.slice(0, 2).map(row => row.id)).toEqual(['new', 'old'])
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get(id('labelled'))).toMatchObject({ title: 'same' })
    expect(byId.get(id('labelled'))).not.toHaveProperty('name')
    // A stopped child's open turn ends at its last event, not at the clock.
    expect(byId.get(id('titled'))).toMatchObject({ title: 'From the title', durationMs: 10_000 })
    expect(byId.get(id('bare'))?.title).toBe('bare')
    expect(byId.get(id('named'))?.title).toBe('worker')
  })

  it('formats the long tails: stopped and idle counts, days, thousands of tokens', () => {
    expect(summaryLine({ ...NO_COUNTS, stopped: 2, idle: 1 }, t)).toBe('2 个中断 · 1 个未运行')
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000, t)).toBe('2 天 3 小时')
    expect(formatTokens(12_345, t)).toBe('12.3K tok')
    expect(formatTokens(123_456, t)).toBe('123K tok')
  })

  it('reads a retry without its count or reason, and a tool phase without its call', () => {
    expect(nowLine(activity({ phase: 'retry', since: NOW }), NOW, t)).toMatchObject({ label: '模型请求失败，第 0 次重试', retrying: true })
    expect(nowLine(activity({ phase: 'retry', since: NOW, retry: { attempt: 1, max: 3, reason: '' } }), NOW, t)).not.toHaveProperty('detail')
    expect(nowLine(activity({ phase: 'tool', since: NOW - 1_000 }), NOW, t).label).toBe('模型思考中')
  })

  it('names the last tool of a running row between calls, failed or not', () => {
    const row = (partial: Partial<SubagentActivity>) => ({ state: 'running', activity: activity(partial) }) as never
    expect(metaParts(row({ phase: 'model', lastTool: { name: 'bash', preview: '', error: true } }), t)).toEqual(['上一个：bash（失败）'])
    expect(metaParts(row({ phase: 'model', lastTool: { name: 'read', preview: '', error: false } }), t)).toEqual(['上一个：read'])
    expect(metaParts(row({ phase: 'tool', lastTool: { name: 'read', preview: '', error: false } }), t)).toEqual([])
  })

  it('says why a row stopped', () => {
    const stopped = (ended?: SubagentActivity['ended']) =>
      endReason({ state: 'stopped', activity: activity(ended === undefined ? {} : { ended }) } as never, t)
    expect(endReason({ state: 'failed' } as never, t)).toBe('出错')
    expect(endReason({ state: 'done' } as never, t)).toBeUndefined()
    expect([stopped('aborted'), stopped('blocked'), stopped('max-tokens'), stopped('forked'), stopped()])
      .toEqual(['被停止', '被拦下', '输出超长后停下', '分叉时结束', '中断'])
  })

  it('stops a wide tree at the size bound, and walks a chain exactly as deep as the bound', () => {
    const wide = tree(Array.from({ length: MAX_TREE_NODES + 5 }, (_, n) => ({ id: id(`w${n}`), createdAt: n, mode: 'oneshot', label: `w${n}` })))
    const index = indexTree(wide, ROOT)
    expect(index.truncated).toBe(true)
    expect(totalOf(index.total)).toBe(MAX_TREE_NODES)

    const links = Array.from({ length: MAX_TREE_DEPTH }, (_, n) => [n === 0 ? ROOT : `d${n}`, `d${n + 1}`] as const)
    const exact: PanelSources = {
      projections: Object.fromEntries(links.map(([parent, child]) => [parent, {
        state: 'ready', values: { subagentCatalog: [{ id: id(child), createdAt: 1, mode: 'oneshot', label: child }] },
      }])) as never,
      summaries: {},
      statuses: new Map(),
    }
    const chain = indexTree(exact, ROOT)
    expect(chain.truncated).toBe(false)
    expect(totalOf(chain.total)).toBe(MAX_TREE_DEPTH)
    // The deepest Session is counted but not walked, so its row has no descendant counts.
    expect(rowsOf(exact, id(`d${MAX_TREE_DEPTH - 1}`), NOW, chain)[0]?.below).toBe(NO_COUNTS)
  })
})

describe('SubagentPanel edges', () => {
  const actions = () => ({ prepare: vi.fn(), openAside: vi.fn(), openMain: vi.fn() })
  const mount = (source: PanelSources, injected = actions()) => {
    render(<SubagentPanel {...{ sessionId: ROOT, ...hooks(source), ...injected, t } as unknown as SubagentPanelProps} />)
    return injected
  }

  it('offers a retry when the catalog read failed, and says it is reading while it loads', () => {
    const injected = mount({ projections: { [ROOT]: { state: 'error', values: {} } } as never, summaries: {}, statuses: new Map() })
    expect(screen.getByRole('alert').textContent).toContain('读取子智能体失败')
    injected.prepare.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(injected.prepare).toHaveBeenCalledWith(ROOT)
    cleanup()
    mount({ projections: { [ROOT]: { state: 'loading', values: {} } } as never, summaries: {}, statuses: new Map() })
    expect(screen.getByRole('status').textContent).toBe('正在读取子智能体…')
  })

  it('marks stopped and never-run rows, and says how long a stalled child has been quiet', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    mount(tree([
      { id: id('stopped'), createdAt: 1, mode: 'oneshot', label: 'Stopped one' },
      { id: id('never'), createdAt: 2, mode: 'oneshot', label: 'Never ran' },
      { id: id('stuck'), createdAt: 3, mode: 'oneshot', label: 'Stuck one' },
    ], {
      stopped: { id: id('stopped'), running: false, projectionValues: { subagentActivity: activity({ ended: 'aborted' }) } },
      stuck: { id: id('stuck'), running: true, projectionValues: { subagentActivity: activity({ phase: 'model', since: NOW - 7 * 60_000, at: NOW - 7 * 60_000 }) } },
    }))
    expect(screen.getByText('Stopped one').closest('li')?.getAttribute('data-state')).toBe('stopped')
    expect(screen.getByText('Never ran').closest('li')?.getAttribute('data-state')).toBe('idle')
    expect(screen.getByText('7 分 00 秒没有新动作')).toBeTruthy()
    vi.useRealTimers()
  })

  it('warns once the tree passes its bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount(tree(Array.from({ length: MAX_TREE_NODES + 1 }, (_, n) => ({ id: id(`w${n}`), createdAt: n, mode: 'oneshot', label: `w${n}` }))))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[subagent-activity]'), ROOT, MAX_TREE_DEPTH, MAX_TREE_NODES)
    warn.mockRestore()
  })
})
