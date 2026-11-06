// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { FlowActivityView, FlowRecentItem, FlowWindowActivity, OverviewView } from '../src/views.ts'
import { GRAPH, GRAPH_BUILT, PLANNED_COUNT } from '../src/client/flow-graph.ts'
import { FlowPage, type FlowProps } from '../src/client/Flow.tsx'
import { clip } from '../src/client/FlowBox.tsx'
import { FlowCanvas } from '../src/client/FlowCanvas.tsx'
import { buildGraph, edgeKey } from '../src/client/flow-model.ts'
import { factOf, rowsThrough, stopsOf, type BoxFact } from '../src/client/flow-view.ts'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'
import { createResourceStore, type ResourceState } from '../src/client/resource.ts'

const t = makeTranslate(zh) as FlowProps['t']
const translate = t as Translate
const NOW = new Date(2026, 10, 6, 9, 30, 15).getTime()

const window = (overrides: Partial<FlowWindowActivity> = {}): FlowWindowActivity => ({
  funnel: { events: 0, batches: 0, sent: 0, silent: 0, failed: 0 }, sources: {}, subscriptions: {}, ignored: 0, ...overrides,
})

const OVERVIEW: OverviewView = {
  checkedAt: NOW,
  cards: [
    { id: 'dsh', tone: 'ok', state: 'up', facts: { version: '0.2.2', sha: '0a1b2c3d4e', uptime: 3600 } },
    { id: 'bus', tone: 'ok', state: 'up', facts: { subscriptions: 3, paused: 0, pending: 0, events: 9, batches: 4, limited: 0 } },
    { id: 'wechat', tone: 'ok', state: 'up', facts: {} },
  ],
}

const QQ_DOWN: OverviewView = { ...OVERVIEW, cards: [...OVERVIEW.cards, { id: 'qq', tone: 'down', state: 'down', facts: {} }] }

const ITEM: FlowRecentItem = { id: 'e1', at: NOW - 60_000, source: 'github', kind: 'ci.failed', title: 'main 构建失败', subscriptions: ['ci'], outcome: 'sent' }

const ACTIVITY: FlowActivityView = {
  checkedAt: NOW,
  presence: { asleep: false, deferred: 0 },
  recent: [ITEM, { ...ITEM, id: 'e2', source: 'host', kind: 'host.test.info', title: '磁盘检查', subscriptions: ['notify-funnel'], outcome: 'silent' }],
  windows: {
    '1h': window({ funnel: { events: 2, batches: 1, sent: 1, silent: 0, failed: 0 } }),
    '24h': window({
      funnel: { events: 40, batches: 6, sent: 3, silent: 3, failed: 2 },
      ignored: 28,
      sources: { github: { count: 12, lastAt: NOW - 60_000 } },
      subscriptions: { ci: { count: 5, lastAt: NOW - 60_000, sent: 2, silent: 3, failed: 0 } },
    }),
    '7d': window({ funnel: { events: 300, batches: 30, sent: 9, silent: 21, failed: 0 } }),
  },
}

interface Reads {
  overview?: Partial<ResourceState<OverviewView>>
  activity?: Partial<ResourceState<FlowActivityView>>
  registered?: string[]
}

function mount({ overview = {}, activity = {}, registered = [] }: Reads = {}) {
  const overviewStore = createResourceStore<OverviewView>()
  overviewStore.update((draft) => { Object.assign(draft, overview) })
  const activityStore = createResourceStore<FlowActivityView>()
  activityStore.update((draft) => { Object.assign(draft, activity) })
  const refresh = vi.fn()
  const openSettings = vi.fn()
  const props = {
    useOverview: bindSnapshotSelector(overviewStore),
    useActivity: bindSnapshotSelector(activityStore),
    refresh,
    openSettings,
    canManage: (section: string) => registered.includes(section),
    t,
  } as unknown as FlowProps
  const view = render(<FlowPage {...props} />)
  return { refresh, openSettings, view }
}

const loaded = (overview: OverviewView = OVERVIEW): Reads => ({
  overview: { data: overview, checkedAt: NOW },
  activity: { data: ACTIVITY, checkedAt: NOW },
})

const node = (id: string): Element => document.querySelector(`[data-node="${id}"]`)!
const edge = (key: string): Element | null => document.querySelector(`[data-edge="${key}"]`)
const side = (): HTMLElement => screen.getByTestId('flow-side')
const figures = (): string[] => Array.from(document.querySelectorAll('strong')).map(figure => figure.textContent)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FlowPage', () => {
  it('reads on opening and every 10 s while open, and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount()
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('draws what is built before any reading arrives, with the loading line, and no arrow for a tool or a call', () => {
    mount()
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(document.querySelectorAll('[data-node]')).toHaveLength(GRAPH_BUILT.nodes.length)
    const drawn = GRAPH_BUILT.edges.filter(arrow => arrow.kind !== 'pull' && arrow.kind !== 'call')
    expect(document.querySelectorAll('[data-edge]')).toHaveLength(drawn.length)
  })

  describe('whether anything is broken', () => {
    it('says so in one line when nothing is', () => {
      mount(loaded())
      expect(screen.getByRole('status').textContent).toBe('一切正常')
    })

    it('names what is broken and what it touches, and marks the box and those it starves', () => {
      mount(loaded(QQ_DOWN))
      const verdict = screen.getByRole('status')
      expect(verdict.textContent).toContain('QQ 观察器')
      expect(verdict.textContent).toContain('QQ 群摘要')
      expect(verdict.textContent).toContain('QQ 主会话')
      expect(verdict.textContent).toContain('其余都正常')
      expect(node('qq').getAttribute('data-state')).toBe('bad')
      expect(node('qq').querySelector('rect')).not.toBeNull()
      expect(node('qqSessions').getAttribute('data-state')).toBe('hit')
      expect(node('qqMain').getAttribute('data-state')).toBe('hit')
      expect(node('github').getAttribute('data-state')).not.toBe('hit')
    })

    it('opens the broken box from the verdict, and goes to its Settings section with the fix', () => {
      const { openSettings } = mount({ ...loaded(QQ_DOWN), registered: ['fork-qq'] })
      const verdict = screen.getByRole('status')
      fireEvent.click(within(verdict).getByRole('button', { name: '去处理' }))
      expect(openSettings).toHaveBeenCalledWith('fork-qq')
      fireEvent.click(within(verdict).getAllByRole('button')[0]!)
      expect(node('qq').getAttribute('aria-pressed')).toBe('true')
      expect(within(side()).getByRole('heading', { level: 2 }).textContent).toBe(zh['flow.node.qq'])
    })

    it('gives a warning the line when nothing is down, without red, and links to its section', () => {
      const limited: OverviewView = { ...OVERVIEW, cards: [...OVERVIEW.cards.filter(card => card.id !== 'bus'), {
        id: 'bus', tone: 'warn', state: 'limited', facts: { subscriptions: 3, paused: 0, pending: 1, events: 9, batches: 4, limited: 2 },
      }] }
      const { openSettings } = mount({ ...loaded(limited), registered: ['fork-subscriptions'] })
      const verdict = screen.getByRole('status')
      expect(verdict.getAttribute('data-state')).toBe('warn')
      expect(verdict.textContent).toContain(zh['card.bus.title'])
      fireEvent.click(within(verdict).getByRole('button', { name: '去处理' }))
      expect(openSettings).toHaveBeenCalledWith('fork-subscriptions')
      expect(node('notifySession').getAttribute('data-state')).not.toBe('warn')
    })

    it('lets down outrank a warning', () => {
      mount(loaded({ ...QQ_DOWN, cards: [...QQ_DOWN.cards, { id: 'style', tone: 'warn', state: 'limited', facts: {} }] }))
      expect(screen.getByRole('status').getAttribute('data-state')).toBe('bad')
    })

    it('offers no fix for a section that is not registered', () => {
      mount(loaded(QQ_DOWN))
      expect(screen.queryByRole('button', { name: '去处理' })).toBeNull()
    })
  })

  describe('how much came in and how much reached the owner', () => {
    it('shows the funnel of the chosen span, and switches span with no new read', () => {
      const { refresh } = mount(loaded())
      expect(figures().slice(0, 3)).toEqual(['40', '6', '3'])
      expect(screen.getByText(zh['flow.funnel.failed'])).toBeTruthy()
      const reads = refresh.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: '7 天' }))
      expect(figures().slice(0, 3)).toEqual(['300', '30', '9'])
      expect(screen.queryByText(zh['flow.funnel.failed'])).toBeNull()
      expect(refresh).toHaveBeenCalledTimes(reads)
      expect(screen.getByRole('button', { name: '7 天' }).getAttribute('aria-pressed')).toBe('true')
    })

    it('counts what waits for the owner to wake only when something does', () => {
      mount({ ...loaded(), activity: { data: { ...ACTIVITY, presence: { asleep: true, deferred: 4 } }, checkedAt: NOW } })
      expect(screen.getByText(zh['flow.funnel.held'])).toBeTruthy()
      expect(node('dnd').textContent).toContain('现在在睡')
    })
  })

  describe('where one event went', () => {
    it('lists what just happened and draws the way of a followed row, one arrow after another', () => {
      mount(loaded())
      const row = within(side()).getByRole('button', { name: /main 构建失败/u })
      expect(row.textContent).toContain('发给你了')
      fireEvent.click(row)
      const runs = Array.from(document.querySelectorAll<SVGPathElement>('[data-run]'))
      expect(runs.length).toBeGreaterThan(1)
      expect(runs[0]!.getAttribute('data-run')!.startsWith('github>')).toBe(true)
      expect(runs.at(-1)!.getAttribute('data-run')!.endsWith('>wechatOut')).toBe(true)
      expect(runs.map(run => run.style.animationDelay)).toEqual(runs.map((_, index) => `${index * 170}ms`))
      expect(node('github').hasAttribute('data-walked')).toBe(true)
      expect(node('bili').hasAttribute('data-dim')).toBe(true)
      fireEvent.click(row)
      expect(document.querySelectorAll('[data-run]')).toHaveLength(0)
    })

    it('says how many it leaves out, for the chosen span, and nothing when none were', () => {
      mount(loaded())
      expect(within(side()).getByText('另有 28 件事没有订阅，这里不列出')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '1 小时' }))
      expect(within(side()).queryByText(/没有订阅/u)).toBeNull()
    })

    it('says so when nothing happened', () => {
      mount()
      expect(within(side()).getByText('这段时间什么也没发生')).toBeTruthy()
    })
  })

  describe('one box', () => {
    it('tells how it stands, what passed it, and what is around it, with its wiring behind a disclosure', () => {
      mount(loaded())
      fireEvent.click(node('githubSessions'))
      const panel = side()
      expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('GitHub CI')
      expect(within(panel).getByRole('button', { name: /main 构建失败/u })).toBeTruthy()
      expect(within(panel).queryByRole('button', { name: /磁盘检查/u })).toBeNull()
      expect(within(panel).getByText(/^来自：/u).textContent).toContain('GitHub')
      expect(panel.querySelector('details')!.hasAttribute('open')).toBe(false)
      expect(panel.querySelector('details')!.textContent).toContain('接线细节')
    })

    it('lights the paths through it, shows the tool arrows that belong to it, and goes back on Escape', () => {
      mount(loaded())
      const pull = GRAPH_BUILT.edges.find(arrow => arrow.kind === 'pull')!
      expect(edge(edgeKey(pull))).toBeNull()
      fireEvent.click(node(pull.to))
      expect(edge(edgeKey(pull))).not.toBeNull()
      expect(edge(edgeKey(pull))!.hasAttribute('data-lit')).toBe(true)
      fireEvent.keyDown(node(pull.to), { key: 'Escape' })
      expect(edge(edgeKey(pull))).toBeNull()
      expect(within(side()).getByText('最近发生了什么')).toBeTruthy()
    })

    it('works from the keyboard, and a second press lets go', () => {
      mount(loaded())
      fireEvent.keyDown(node('main'), { key: 'Enter' })
      expect(node('main').getAttribute('aria-pressed')).toBe('true')
      fireEvent.keyDown(node('main'), { key: ' ' })
      expect(node('main').getAttribute('aria-pressed')).toBe('false')
    })

    it('offers Manage only for a registered section, and returns to the list', () => {
      const { openSettings } = mount({ ...loaded(), registered: ['fork-wechat'] })
      fireEvent.click(node('wechatOut'))
      fireEvent.click(within(side()).getByRole('button', { name: '管理' }))
      expect(openSettings).toHaveBeenCalledWith('fork-wechat')
      fireEvent.click(within(side()).getByRole('button', { name: '← 看全部' }))
      expect(node('wechatOut').getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(node('github'))
      expect(within(side()).queryByRole('button', { name: '管理' })).toBeNull()
    })
  })

  it('hides what is not built until asked for', () => {
    mount(loaded())
    expect(document.querySelectorAll('[data-node]')).toHaveLength(GRAPH_BUILT.nodes.length)
    fireEvent.click(screen.getByRole('checkbox', { name: `显示未建成的 ${PLANNED_COUNT} 项` }))
    expect(document.querySelectorAll('[data-node]')).toHaveLength(GRAPH.nodes.length)
    expect(document.querySelectorAll('[data-state="planned"]')).toHaveLength(PLANNED_COUNT)
  })

  it('keeps the last picture with a quiet stale line', () => {
    mount({ overview: { data: OVERVIEW, checkedAt: NOW, stale: true }, activity: { data: ACTIVITY, checkedAt: NOW, stale: true } })
    expect(screen.getByText(/未能刷新/u)).toBeTruthy()
    expect(figures().slice(0, 3)).toEqual(['40', '6', '3'])
  })
})

describe('FlowCanvas', () => {
  const box = (id: string) => ({ id, role: 'core' as const })
  const facts = (entries: Record<string, Partial<BoxFact>>): Map<string, BoxFact> =>
    new Map(Object.entries(entries).map(([id, fact]) => [id, { state: 'plain' as const, text: '', count: 0, lastAt: null, ...fact }]))
  const draw = (graph: ReturnType<typeof buildGraph>, given: Map<string, BoxFact>) => render(
    <FlowCanvas graph={graph} facts={given} chosen={null} walk={[]} walkKey="" now={NOW} onChoose={() => {}} onClear={() => {}} translate={translate} />,
  )
  const pair = buildGraph([box('a'), box('b')], [{ from: 'a', to: 'b', kind: 'event' }])

  it('runs a dot along an arrow used in the last minutes, and not along an old or broken one', () => {
    draw(pair, facts({ a: { lastAt: NOW - 60_000, count: 3 } }))
    expect(document.querySelector('[data-dot="a>b"]')).not.toBeNull()
    cleanup()
    draw(pair, facts({ a: { lastAt: NOW - 3_600_000, count: 3 } }))
    expect(document.querySelector('[data-dot="a>b"]')).toBeNull()
    cleanup()
    draw(pair, facts({ a: { state: 'bad', lastAt: NOW - 60_000 } }))
    expect(document.querySelector('[data-dot="a>b"]')).toBeNull()
    expect(edge('a>b')!.getAttribute('data-state')).toBe('broken')
  })

  it('writes the words above the columns of a graph on fixed cells, and shrinks to fit only so far', () => {
    render(
      <FlowCanvas
        graph={pair} facts={facts({})} chosen={null} walk={[]} walkKey="" now={NOW} onChoose={() => {}} onClear={() => {}}
        translate={translate} lanes={[{ column: 0, label: '从哪来' }]}
      />,
    )
    expect(screen.getByText('从哪来').tagName.toLowerCase()).toBe('text')
    const svg = document.querySelector('svg')!
    expect(svg.style.width).toBe('100%')
    expect(Number.parseFloat(svg.style.minWidth)).toBeLessThan(pair.layout.width)
    expect(Number.parseFloat(svg.style.maxWidth)).toBe(pair.layout.width)
  })

  it('never runs more than ten dots', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `n${index}`)
    const graph = buildGraph([box('hub'), ...ids.map(box)], ids.map(id => ({ from: 'hub', to: id, kind: 'event' as const })))
    draw(graph, facts({ hub: { lastAt: NOW - 1_000, count: 1 } }))
    expect(document.querySelectorAll('[data-dot]')).toHaveLength(10)
  })

  it('makes an arrow heavier the more passed it, within a limit', () => {
    const widthAt = (count: number): number => {
      draw(pair, facts({ a: { count } }))
      const width = Number((edge('a>b') as SVGPathElement).style.strokeWidth)
      cleanup()
      return width
    }
    expect(widthAt(0)).toBe(1)
    expect(widthAt(9)).toBe(2)
    expect(widthAt(1_000_000)).toBe(3.25)
  })
})

describe('factOf', () => {
  const sources = (overrides: Partial<Parameters<typeof factOf>[1]> = {}): Parameters<typeof factOf>[1] => ({
    cards: new Map(OVERVIEW.cards.map(card => [card.id, card])), activity: ACTIVITY, span: '24h', now: NOW, t: translate, ...overrides,
  })
  const down = new Map(QQ_DOWN.cards.map(card => [card.id, card]))

  it('says what is wrong first, for the box itself and for one that needs it', () => {
    expect(factOf(GRAPH.node('qq')!, sources({ cards: down })).state).toBe('bad')
    const hit = factOf(GRAPH.node('qqMain')!, sources({ cards: down }))
    expect(hit.state).toBe('hit')
    expect(hit.text).toBe('QQ 观察器断开')
  })

  it('counts a source\'s events with the time of the latest', () => {
    const fact = factOf(GRAPH.node('github')!, sources())
    expect(fact).toMatchObject({ state: 'plain', count: 12, lastAt: NOW - 60_000 })
    expect(fact.text).toMatch(/^12 件 · /u)
  })

  it('counts a Session\'s batches and how many reached the owner', () => {
    expect(factOf(GRAPH.node('githubSessions')!, sources()).text).toBe('5 批 · 2 条告诉你')
  })

  it('says a box saw nothing, for the chosen span', () => {
    expect(factOf(GRAPH.node('github')!, sources({ span: '1h' }))).toMatchObject({ state: 'idle', text: '1 小时没有事件' })
  })

  it('reads the sent count on the owner\'s WeChat and the sleep state on do-not-disturb', () => {
    expect(factOf(GRAPH.node('wechatOut')!, sources()).text).toBe('3 条发给你')
    expect(factOf(GRAPH.node('dnd')!, sources()).text).toBe('现在醒着')
  })

  it('says nothing about a healthy box the bus does not know', () => {
    expect(factOf(GRAPH.node('main')!, sources())).toMatchObject({ state: 'plain', text: '' })
  })

  it('marks a box that is not built, whatever its service says', () => {
    const planned = GRAPH.nodes.find(box => box.wired === 'planned')!
    expect(factOf(planned, sources()).state).toBe('planned')
  })
})

describe('stopsOf', () => {
  it('walks from the source through the Sessions that took it, and to the owner\'s WeChat when it reached them', () => {
    expect(stopsOf(GRAPH_BUILT, ITEM)).toEqual(['github', 'githubSessions', 'wechatOut'])
    expect(stopsOf(GRAPH_BUILT, { ...ITEM, outcome: 'silent' })).toEqual(['github', 'githubSessions'])
  })

  it('has no stops for a source no box stands for', () => {
    expect(stopsOf(GRAPH_BUILT, { ...ITEM, source: 'nobody', subscriptions: [], outcome: 'unmatched' })).toEqual([])
  })

  it('finds the rows through a box', () => {
    expect(rowsThrough(GRAPH_BUILT, 'githubSessions', ACTIVITY.recent).map(row => row.id)).toEqual(['e1'])
    expect(rowsThrough(GRAPH_BUILT, 'qq', ACTIVITY.recent)).toEqual([])
  })
})

describe('clip', () => {
  it('keeps a line that fits', () => {
    expect(clip('十二个字十二个字', 8)).toBe('十二个字十二个字')
  })

  it('cuts a longer line with an ellipsis, counting a Latin character as half', () => {
    expect(clip('十三个字十三个字十', 8)).toBe('十三个字十三个字…')
    expect(clip('abcdefghijklmnopqrstuvwxyz', 8)).toBe('abcdefghijklmn…')
  })
})
