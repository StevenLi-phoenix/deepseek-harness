import { describe, expect, it } from 'vitest'
import { NODE_H, NODE_W, buildGraph, edgeKey, problems, type FlowEdge, type FlowNode } from '../src/client/flow-model.ts'

const box = (id: string, role: FlowNode['role'] = 'core', extra: Partial<FlowNode> = {}): FlowNode => ({ id, role, ...extra })
const arrow = (from: string, to: string, extra: Partial<FlowEdge> = {}): FlowEdge => ({ from, to, kind: 'event', ...extra })

/** a -> b -> d and a -> c -> d, plus a long way round a -> d. */
const DIAMOND = {
  nodes: [box('a'), box('b'), box('c'), box('d')],
  edges: [arrow('a', 'b'), arrow('a', 'c'), arrow('b', 'd'), arrow('c', 'd'), arrow('a', 'd')],
}

describe('buildGraph layout', () => {
  it('puts a box one column after the latest box that feeds it', () => {
    const { layout } = buildGraph(DIAMOND.nodes, DIAMOND.edges)
    expect(layout.rank).toEqual({ a: 0, b: 1, c: 1, d: 2 })
    expect(layout.ranks).toBe(3)
  })

  it('never lets a box share a column with a box it feeds', () => {
    const { layout } = buildGraph(DIAMOND.nodes, DIAMOND.edges)
    for (const edge of DIAMOND.edges) expect(layout.rank[edge.from]!).toBeLessThan(layout.rank[edge.to]!)
  })

  it('moves a source right up to the first box it feeds', () => {
    const nodes = [box('s', 'source'), box('a'), box('b'), box('c')]
    const edges = [arrow('a', 'b'), arrow('b', 'c'), arrow('s', 'c')]
    expect(buildGraph(nodes, edges).layout.rank).toEqual({ a: 0, b: 1, c: 2, s: 1 })
  })

  it('keeps a box out of the columns before its minRank', () => {
    const nodes = [box('a'), box('b', 'core', { minRank: 3 })]
    const { layout } = buildGraph(nodes, [arrow('a', 'b')])
    expect(layout.rank.b).toBe(3)
  })

  it('keeps boxes in a column from overlapping and inside the canvas', () => {
    const nodes = [box('a'), ...['b', 'c', 'd', 'e'].map(id => box(id))]
    const { layout } = buildGraph(nodes, ['b', 'c', 'd', 'e'].map(id => arrow('a', id)))
    const ys = ['b', 'c', 'd', 'e'].map(id => layout.at[id]!.y).sort((x, y) => x - y)
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(NODE_H)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const at = layout.at[id]!
      expect(at.x).toBeGreaterThanOrEqual(0)
      expect(at.y).toBeGreaterThanOrEqual(0)
      expect(at.x + NODE_W).toBeLessThanOrEqual(layout.width)
      expect(at.y + NODE_H).toBeLessThanOrEqual(layout.height)
    }
  })

  it('centres a short column against the tallest one', () => {
    const nodes = [box('a'), box('b'), box('c'), box('d')]
    const { layout } = buildGraph(nodes, [arrow('a', 'b'), arrow('a', 'c'), arrow('a', 'd')])
    const tops = ['b', 'c', 'd'].map(id => layout.at[id]!.y)
    const middle = (Math.min(...tops) + Math.max(...tops) + NODE_H) / 2
    expect(layout.at.a!.y + NODE_H / 2).toBeCloseTo(middle)
  })

  it('orders a column by where its neighbours sit, so arrows between two columns do not cross', () => {
    const nodes = [box('a1'), box('a2'), box('b1'), box('b2')]
    const { layout } = buildGraph(nodes, [arrow('a1', 'b2'), arrow('a2', 'b1')])
    const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(id => layout.at[id]!.y)
    expect(Math.sign(a1! - a2!)).toBe(Math.sign(b2! - b1!))
  })

  it('lays out a graph with no box without a NaN', () => {
    const { layout } = buildGraph([], [])
    expect(layout.ranks).toBe(0)
    expect(Number.isFinite(layout.width)).toBe(true)
    expect(Number.isFinite(layout.height)).toBe(true)
  })

  it('refuses a cycle and names the boxes in it', () => {
    const nodes = [box('a'), box('b'), box('c')]
    expect(() => buildGraph(nodes, [arrow('a', 'b'), arrow('b', 'c'), arrow('c', 'b')])).toThrow(/cycle through b, c/)
  })
})

describe('buildGraph lookups', () => {
  const graph = buildGraph(DIAMOND.nodes, DIAMOND.edges)

  it('finds a box by id and throws for the spot of one that is not there', () => {
    expect(graph.node('b')?.id).toBe('b')
    expect(graph.node('zz')).toBeUndefined()
    expect(() => graph.spot('zz')).toThrow(/no box zz/)
  })

  it('draws an arrow from the right side of its source to the left side of its target', () => {
    const from = graph.spot('a')
    const to = graph.spot('b')
    const path = graph.path('a', 'b')
    expect(path.startsWith(`M${from.x + NODE_W} ${from.y + NODE_H / 2}`)).toBe(true)
    expect(path.endsWith(`${to.x} ${to.y + NODE_H / 2}`)).toBe(true)
  })

  it('puts the middle of an arrow halfway between its two ends', () => {
    const from = graph.spot('a')
    const to = graph.spot('b')
    const mid = graph.mid('a', 'b')
    expect(mid.x).toBeCloseTo((from.x + NODE_W + to.x) / 2)
    expect(mid.y).toBeCloseTo((from.y + to.y) / 2 + NODE_H / 2)
  })

  it('lists the boxes one step away in the order the arrows are written', () => {
    expect(graph.neighbours('a')).toEqual({ before: [], after: ['b', 'c', 'd'] })
    expect(graph.neighbours('d')).toEqual({ before: ['b', 'c', 'a'], after: [] })
  })

  it('collects the boxes and arrows on a path through a box, but not a sibling branch or a shortcut around it', () => {
    const { nodes, edges } = graph.relatives('b')
    expect([...nodes].sort()).toEqual(['a', 'b', 'd'])
    expect([...edges].sort()).toEqual(['a>b', 'b>d'])
    expect(nodes.has('c')).toBe(false)
    expect(edges.has('a>d')).toBe(false)
  })

  it('gives a box with no arrow only itself', () => {
    const lone = buildGraph([box('x'), ...DIAMOND.nodes], DIAMOND.edges)
    expect([...lone.relatives('x').nodes]).toEqual(['x'])
    expect(lone.relatives('x').edges.size).toBe(0)
  })
})

describe('problems', () => {
  const sound = [
    box('in', 'source'), box('q', 'cond'), box('yes'), box('no'),
  ]
  const soundEdges = [arrow('in', 'q'), arrow('q', 'yes', { branch: 'yes' }), arrow('q', 'no', { branch: 'no' })]

  it('finds nothing wrong with a sound graph, question included', () => {
    expect(problems(sound, soundEdges)).toEqual([])
    expect(problems(DIAMOND.nodes, DIAMOND.edges)).toEqual([])
  })

  it('names a box listed twice', () => {
    expect(problems([...sound, box('yes')], soundEdges)).toEqual(['box yes is listed twice'])
  })

  it('names an arrow to a box that is not there, a loop, and a repeat', () => {
    expect(problems(DIAMOND.nodes, [...DIAMOND.edges, arrow('d', 'zz')])).toContain('arrow d>zz joins zz, which is not a box')
    expect(problems(DIAMOND.nodes, [...DIAMOND.edges, arrow('b', 'b')])).toContain('arrow b>b loops back to its own box')
    expect(problems(DIAMOND.nodes, [...DIAMOND.edges, arrow('a', 'b')])).toContain('arrow a>b is drawn twice')
  })

  it('names a box with no arrow', () => {
    expect(problems([...DIAMOND.nodes, box('lone')], DIAMOND.edges)).toEqual(['box lone has no arrow'])
  })

  it('names a cycle without throwing', () => {
    const found = problems([box('a'), box('b')], [arrow('a', 'b'), arrow('b', 'a')])
    expect(found).toEqual(['arrows form a cycle through a, b'])
  })

  it('names a question that is asked by nothing, has one way out, leaves an answer off, or answers twice', () => {
    expect(problems([box('q', 'cond'), box('x'), box('y')], [arrow('q', 'x', { branch: 'yes' }), arrow('q', 'y', { branch: 'no' })]))
      .toEqual(['question q is asked by nothing'])
    expect(problems([...sound.slice(0, 3)], soundEdges.slice(0, 2))).toEqual(['question q needs at least two arrows out'])
    expect(problems(sound, [arrow('in', 'q'), arrow('q', 'yes', { branch: 'yes' }), arrow('q', 'no')]))
      .toEqual(['arrow q>no leaves question q with no answer'])
    expect(problems(sound, [arrow('in', 'q'), arrow('q', 'yes', { branch: 'yes' }), arrow('q', 'no', { branch: 'yes' })]))
      .toEqual(['question q answers yes twice'])
  })

  it('names an answer written on an arrow that leaves an ordinary box', () => {
    expect(problems(DIAMOND.nodes, [arrow('a', 'b', { branch: 'yes' }), ...DIAMOND.edges.slice(1)]))
      .toEqual(['arrow a>b carries an answer but a asks no question'])
  })
})

describe('a graph on fixed cells', () => {
  const nodes = [box('a', 'core', { cell: [0, 0] }), box('b', 'core', { cell: [1, 2] }), box('c', 'core', { cell: [1, 0] })]
  const edges = [arrow('a', 'b'), arrow('a', 'c'), arrow('c', 'b')]

  it('puts each box on its cell and sizes the canvas to fit', () => {
    const { layout } = buildGraph(nodes, edges)
    expect(layout.at.b!.x).toBe(layout.at.c!.x)
    expect(layout.at.a!.y).toBe(layout.at.c!.y)
    expect(layout.at.b!.y).toBeGreaterThan(layout.at.c!.y + NODE_H)
    expect(layout.width).toBeGreaterThanOrEqual(layout.at.b!.x + NODE_W)
    expect(layout.height).toBeGreaterThanOrEqual(layout.at.b!.y + NODE_H)
  })

  it('falls back to the arrows when any box has no cell', () => {
    const { layout } = buildGraph([...nodes.slice(0, 2), box('c')], edges)
    expect(layout.rank).toEqual({ a: 0, c: 1, b: 2 })
  })

  it('leads an arrow within a column out of the bottom of its source, not across the box', () => {
    const graph = buildGraph(nodes, edges)
    const { x, y } = graph.spot('c')
    expect(graph.path('c', 'b').startsWith(`M${x + NODE_W / 2} ${y + NODE_H} `)).toBe(true)
  })
})

describe('route', () => {
  const graph = buildGraph(
    [box('a'), box('b'), box('c'), box('d'), box('t')],
    [arrow('a', 'b'), arrow('b', 'c'), arrow('a', 'c'), arrow('c', 'd'), arrow('t', 'c', { kind: 'pull' })],
  )
  const keys = (stops: string[]): string[] => graph.route(stops).map(edgeKey)

  it('takes the shortest way between stops, in walking order', () => {
    expect(keys(['a', 'd'])).toEqual(['a>c', 'c>d'])
    expect(keys(['a', 'b', 'd'])).toEqual(['a>b', 'b>c', 'c>d'])
  })

  it('walks no arrow for a lookup, and skips a step with no way', () => {
    expect(keys(['t', 'd'])).toEqual([])
    expect(keys(['a', 't', 'b'])).toEqual(['a>b'])
    expect(keys(['a'])).toEqual([])
  })
})

describe('edgeKey', () => {
  it('joins the two ends with an arrow', () => {
    expect(edgeKey({ from: 'a', to: 'b' })).toBe('a>b')
  })
})

describe('lookups for a box the graph does not have', () => {
  const graph = buildGraph(DIAMOND.nodes, DIAMOND.edges)

  it('has no neighbours and no relatives for it', () => {
    expect(graph.neighbours('ghost')).toEqual({ before: [], after: [] })
    const { nodes, edges } = graph.relatives('ghost')
    expect([...nodes]).toEqual(['ghost'])
    expect([...edges]).toEqual([])
  })

  it('walks nowhere from a stop it does not have, and from no stops at all', () => {
    expect(graph.route(['ghost', 'd'])).toEqual([])
    expect(graph.route([])).toEqual([])
    expect(graph.route(['a'])).toEqual([])
  })
})
