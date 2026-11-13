import { describe, expect, it } from 'vitest'
import { EDGES, GRAPH, GRAPH_BUILT, NODES, PLANNED_COUNT } from '../src/client/flow-graph.ts'
import { edgeKey, problems } from '../src/client/flow-model.ts'
import { SERVICE_IDS } from '../src/views.ts'
import { zh } from '../src/client/locales.ts'

const ids = NODES.map(node => node.id)

describe('flow topology', () => {
  it('is a sound graph: unique boxes, no dangling, looping or repeated arrow, no lone box, no cycle, every question answered both ways', () => {
    expect(problems(NODES, EDGES)).toEqual([])
  })

  it('leaves shared infrastructure out: model routing is not a step of the message flow', () => {
    expect(ids).not.toContain('llm')
    expect(NODES.some(node => node.service === 'llm')).toBe(false)
  })

  it('binds nodes only to services the overview knows', () => {
    for (const node of NODES) if (node.service !== undefined) expect(SERVICE_IDS).toContain(node.service)
  })

  it('names every node: a title of its own, or a title and a description in the dictionary', () => {
    for (const node of NODES) {
      if (node.title !== undefined) { expect(node.title, node.id).not.toBe(''); continue }
      expect(zh, node.id).toHaveProperty(`flow.node.${node.id}`)
      expect(zh, node.id).toHaveProperty(`flow.node.${node.id}.desc`)
    }
  })

  it('keeps no dictionary entry for a box the graph no longer has', () => {
    const named = new Set(Object.keys(zh).filter(key => key.startsWith('flow.node.')).map(key => key.split('.')[2]))
    for (const id of named) expect(ids, `flow.node.${id}`).toContain(id)
  })

  it('asks at least one question', () => {
    expect(NODES.some(node => node.role === 'cond')).toBe(true)
  })

  it('has an answer in the dictionary for each branch', () => {
    expect(zh).toHaveProperty('flow.branch.yes')
    expect(zh).toHaveProperty('flow.branch.no')
  })
})

describe('flow wiring', () => {
  const wiringOf = (node: (typeof NODES)[number]): string => node.wired ?? 'live'

  it('says for every box how far the running service matches it, and what carries it', () => {
    for (const node of NODES) {
      expect(['live', 'partial', 'planned'], node.id).toContain(node.wired ?? 'live')
      if (wiringOf(node) !== 'planned') expect(node.via, `${node.id} runs as something`).toBeTruthy()
      if (wiringOf(node) !== 'live') expect(node.gap, `${node.id} says how it differs`).toBeTruthy()
    }
  })

  it('keeps a probe\'s health dot off a box that is not built', () => {
    for (const node of NODES.filter(box => box.wired === 'planned')) {
      expect(node.service, node.id).toBeUndefined()
      expect(node.via, node.id).toBeUndefined()
    }
  })

  it('has the words for each state and for what carries a box, in every language', () => {
    for (const key of ['flow.wired.live', 'flow.wired.partial', 'flow.wired.planned', 'flow.via']) expect(zh).toHaveProperty(key)
  })

  it('draws the do-not-disturb state as it works: it holds outgoing messages, and nothing merges into the main agent', () => {
    expect(ids).not.toContain('merge')
    const arrows = new Set(EDGES.map(edge => `${edge.from}>${edge.to}`))
    for (const arrow of ['presence>dnd', 'dnd>deferQ', 'main>deferQ', 'deferQ>wechatOut', 'schedule>main']) expect(arrows.has(arrow), arrow).toBe(true)
    expect(arrows.has('presence>notifySession')).toBe(false)
  })
})

describe('flow layout', () => {
  it('gives every box a cell of its own, so nothing overlaps', () => {
    const cells = NODES.map(node => node.cell!.join(','))
    expect(new Set(cells).size).toBe(NODES.length)
  })

  it('keeps each source in the first column, and the owner\'s WeChat in the last', () => {
    for (const node of NODES.filter(box => box.role === 'source')) expect(node.cell![0], node.id).toBe(0)
    const last = Math.max(...NODES.map(node => node.cell![0]))
    expect(GRAPH.node('wechatOut')!.cell![0]).toBe(last)
  })

  it('leaves out of the first view what is not built, with the arrows that touch it', () => {
    expect(GRAPH_BUILT.nodes.length + PLANNED_COUNT).toBe(NODES.length)
    expect(GRAPH_BUILT.nodes.some(node => node.wired === 'planned')).toBe(false)
    const built = new Set(GRAPH_BUILT.nodes.map(node => node.id))
    for (const edge of GRAPH_BUILT.edges) expect(built.has(edge.from) && built.has(edge.to), edgeKey(edge)).toBe(true)
  })
})

describe('flow counts', () => {
  it('ties to the bus only what a box really carries: a tracked box is built, a box that needs a service knows the service', () => {
    for (const node of NODES) {
      if (node.tracks !== undefined) expect(node.wired, node.id).not.toBe('planned')
      if (node.needs !== undefined) expect(SERVICE_IDS, node.id).toContain(node.needs)
    }
  })

  it('walks a row of a tracked source to the owner\'s WeChat along arrows that exist', () => {
    const way = GRAPH_BUILT.route(['github', 'githubSessions', 'wechatOut'])
    expect(way[0]!.from).toBe('github')
    expect(way.at(-1)!.to).toBe('wechatOut')
    for (let index = 1; index < way.length; index += 1) expect(way[index]!.from).toBe(way[index - 1]!.to)
  })
})

describe('relatives', () => {
  it('collects everything upstream and downstream of a node, and the edges between them', () => {
    const { nodes, edges } = GRAPH.relatives('repairQ')
    expect(nodes.has('repairQ')).toBe(true)
    expect(nodes.has('amsGroup')).toBe(true)
    expect(nodes.has('ams')).toBe(true)
    expect(nodes.has('github')).toBe(true)
    expect(nodes.has('wechatOut')).toBe(true)
    expect(nodes.has('wechatIn')).toBe(false)
    expect(edges.has('amsGroup>repairQ')).toBe(true)
    expect(edges.has('repairQ>repair')).toBe(true)
    expect(edges.has('wechatIn>main')).toBe(false)
  })

  it('keeps a source to its own descendants', () => {
    const { nodes } = GRAPH.relatives('wechatIn')
    expect(nodes.has('main')).toBe(true)
    expect(nodes.has('wechatOut')).toBe(true)
    expect(nodes.has('github')).toBe(false)
  })
})
