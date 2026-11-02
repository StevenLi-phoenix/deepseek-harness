import { describe, expect, it } from 'vitest'
import { EDGES, GRAPH, NODES } from '../src/client/flow-graph.ts'
import { problems } from '../src/client/flow-model.ts'
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

describe('flow layout', () => {
  it('puts a question after what feeds it and the owner\'s WeChat last', () => {
    expect(GRAPH.layout.rank.repairQ).toBeGreaterThan(GRAPH.layout.rank.amsGroup!)
    expect(GRAPH.layout.rank.repair).toBeGreaterThan(GRAPH.layout.rank.repairQ!)
    expect(GRAPH.layout.rank.main).toBeGreaterThan(GRAPH.layout.rank.notifySession!)
    expect(GRAPH.layout.rank.wechatOut).toBe(GRAPH.layout.ranks - 1)
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
