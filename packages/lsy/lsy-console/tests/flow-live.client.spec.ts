import { describe, expect, it } from 'vitest'
import { GRAPH_BUILT } from '../src/client/flow-graph.ts'
import { liveGraph, routeSignature } from '../src/client/flow-live.ts'
import { factOf } from '../src/client/flow-view.ts'
import type { FlowActivityView, FlowRoute } from '../src/views.ts'

const route = (id: string, fields: Partial<FlowRoute> = {}): FlowRoute => ({
  id, origin: 'config', sources: [], kinds: [], subjects: [], paused: false, removed: false, changedAt: null, result: 'notify', downstream: [], instructions: null, ...fields,
})

const arrow = (graph: ReturnType<typeof liveGraph>, from: string, to: string): boolean =>
  graph.edges.some(edge => edge.from === from && edge.to === to)

describe('liveGraph', () => {
  it('leaves the drawing as it is when no route was touched', () => {
    expect(liveGraph(GRAPH_BUILT, [route('ci', { sources: ['github'] })])).toBe(GRAPH_BUILT)
  })

  it('redraws a changed route from what it really does', () => {
    const graph = liveGraph(GRAPH_BUILT, [
      route('ci', { sources: ['github'], changedAt: 1, result: 'event', downstream: ['notify-funnel'] }),
      route('notify-funnel', { sources: ['host', 'flow'] }),
    ])
    expect(arrow(graph, 'github', 'githubSessions')).toBe(true)
    expect(arrow(graph, 'githubSessions', 'notifySession')).toBe(true)
    expect(arrow(graph, 'githubSessions', 'repairQ')).toBe(false)
    expect(graph.node('githubSessions')).toMatchObject({ wired: 'live', route: 'ci' })
    expect(graph.node('githubSessions')?.gap).toBeUndefined()
  })

  it('gives a new route a box of its own under the drawing, on the way from its source to the owner', () => {
    const graph = liveGraph(GRAPH_BUILT, [route('new-one', { origin: 'agent', sources: ['github'], result: 'urgent' })])
    expect(graph.node('route:new-one')).toMatchObject({ title: 'new-one', cell: [1, 13] })
    expect(arrow(graph, 'github', 'route:new-one')).toBe(true)
    expect(arrow(graph, 'route:new-one', 'wechatOut')).toBe(true)
  })

  it('draws a chain of new routes one column after another, and a route taken to the main agent', () => {
    const graph = liveGraph(GRAPH_BUILT, [
      route('first', { origin: 'agent', sources: ['host'], result: 'event', downstream: ['second'] }),
      route('second', { origin: 'agent', sources: ['flow'], result: 'main' }),
    ])
    expect(graph.node('route:first')?.cell?.[0]).toBe(1)
    expect(graph.node('route:second')?.cell?.[0]).toBe(2)
    expect(arrow(graph, 'route:first', 'route:second')).toBe(true)
    expect(arrow(graph, 'route:second', 'main')).toBe(true)
  })

  it('stays drawable when an arrow of the drawing would close a loop', () => {
    const graph = liveGraph(GRAPH_BUILT, [
      route('notify-funnel', { sources: ['host'], changedAt: 1, result: 'event', downstream: ['ci'] }),
      route('ci', { sources: ['github', 'flow'] }),
    ])
    expect(arrow(graph, 'notifySession', 'githubSessions')).toBe(false)
    expect(graph.nodes.length).toBe(GRAPH_BUILT.nodes.length)
  })

  it('takes every arrow from a removed route and says so on the box', () => {
    const routes = [route('ci', { sources: ['github'], changedAt: 1, removed: true })]
    const graph = liveGraph(GRAPH_BUILT, routes)
    expect(arrow(graph, 'github', 'githubSessions')).toBe(false)
    const none = { funnel: { events: 0, batches: 0, sent: 0, silent: 0, failed: 0 }, sources: {}, subscriptions: {}, ignored: 0 }
    const activity: FlowActivityView = { routes, windows: { '1h': none, '24h': none, '7d': none }, recent: [], changes: [], presence: null, checkedAt: 0 }
    const node = graph.node('githubSessions')
    if (node === undefined) throw new Error('missing box')
    expect(factOf(node, { cards: new Map(), activity, span: '24h', now: 0, t: (key: string) => key }).text).toBe('flow.fact.removed')
  })
})

describe('routeSignature', () => {
  it('changes with the shape of a touched route and not with anything else', () => {
    const one = route('ci', { changedAt: 1 })
    expect(routeSignature([one])).toBe(routeSignature([{ ...one, changedAt: 2, instructions: 'other' }, route('calm')]))
    expect(routeSignature([one])).not.toBe(routeSignature([{ ...one, result: 'quiet' }]))
  })
})
