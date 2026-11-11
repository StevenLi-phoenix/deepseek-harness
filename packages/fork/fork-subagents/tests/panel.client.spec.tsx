// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ForkSubagentActivity } from '../src/activity.ts'
import { zh } from '../src/client/locales.ts'
import {
  classify, countStates, endReason, finishedLabel, formatClock, formatDuration, formatTokens, nowLine, rowsOf, summaryLine,
  type PanelSources, type T,
} from '../src/client/model.ts'
import { SubagentPanel, type SubagentPanelProps } from '../src/client/SubagentPanel.tsx'
import { SubagentToggle, type SubagentToggleProps } from '../src/client/SubagentToggle.tsx'

const t = makeTranslate(zh) as T
const ROOT = 'session-root' as SessionId
const NOW = 1_000_000_000

const id = (value: string) => value as SessionId

function activity(partial: Partial<ForkSubagentActivity>): ForkSubagentActivity {
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
        forkSubagentActivity: activity({ ended: 'completed', at: NOW - 50_000, note: { kind: 'text', text: '已解决 12 个冲突并推到 main' } }),
      }),
      run: summary('run', true, {
        subagentTiming: { settledMs: 0, active: { since: NOW - 780_000, through: NOW - 1_000 } },
        forkSubagentActivity: activity({
          phase: 'tool', since: NOW - 8_000, at: NOW - 8_000, step: 34, toolCalls: 48,
          tool: { name: 'bash', preview: 'Find all point insert paths', open: 1 },
          note: { kind: 'thought', text: 'I have spent a lot; let me decide and implement.' },
        }),
      }),
      fail: summary('fail', false, {
        subagentTiming: { settledMs: 40_000 },
        forkSubagentActivity: activity({ ended: 'error', error: 'UNKNOWN_MODEL', at: NOW - 10_000 }),
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
