import { describe, expect, it } from 'vitest'
import { EDGES, LAYOUT, NODES, NODE_H, NODE_W, edgeMid, edgePath, relatives } from '../src/client/flow-graph.ts'
import { SERVICE_IDS } from '../src/views.ts'
import { zh } from '../src/client/locales.ts'

const ids = NODES.map(node => node.id)

describe('flow topology', () => {
  it('has unique node ids and edges that join known nodes without a self-loop or a duplicate', () => {
    expect(new Set(ids).size).toBe(ids.length)
    const seen = new Set<string>()
    for (const edge of EDGES) {
      expect(ids, `${edge.from} -> ${edge.to}`).toContain(edge.from)
      expect(ids, `${edge.from} -> ${edge.to}`).toContain(edge.to)
      expect(edge.from).not.toBe(edge.to)
      const key = `${edge.from}>${edge.to}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  it('is acyclic: every edge points to a later rank', () => {
    for (const edge of EDGES) expect(LAYOUT.rank[edge.from]!, `${edge.from} -> ${edge.to}`).toBeLessThan(LAYOUT.rank[edge.to]!)
  })

  it('leaves shared infrastructure out: model routing is not a step of the message flow', () => {
    expect(ids).not.toContain('llm')
    expect(NODES.some(node => node.service === 'llm')).toBe(false)
  })

  it('leaves no node alone', () => {
    for (const id of ids) expect(EDGES.some(edge => edge.from === id || edge.to === id), id).toBe(true)
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

  it('draws a question as a cond box whose every arrow out carries its own answer, and only such arrows carry one', () => {
    const conds = NODES.filter(node => node.role === 'cond').map(node => node.id)
    expect(conds.length).toBeGreaterThan(0)
    for (const id of conds) {
      const branches = EDGES.filter(edge => edge.from === id).map(edge => edge.branch)
      expect(branches.length, id).toBeGreaterThanOrEqual(2)
      expect(new Set(branches).size, id).toBe(branches.length)
      for (const branch of branches) expect(branch, id).toBeDefined()
      expect(EDGES.some(edge => edge.to === id), id).toBe(true)
    }
    for (const edge of EDGES) if (edge.branch !== undefined) expect(conds, `${edge.from}>${edge.to}`).toContain(edge.from)
  })

  it('has an answer in the dictionary for each branch', () => {
    expect(zh).toHaveProperty('flow.branch.yes')
    expect(zh).toHaveProperty('flow.branch.no')
  })
})

describe('flow layout', () => {
  it('puts a question after what feeds it and the owner\'s WeChat last', () => {
    expect(LAYOUT.rank.repairQ).toBeGreaterThan(LAYOUT.rank.amsGroup!)
    expect(LAYOUT.rank.repair).toBeGreaterThan(LAYOUT.rank.repairQ!)
    expect(LAYOUT.rank.main).toBeGreaterThan(LAYOUT.rank.notifySession!)
    expect(LAYOUT.rank.wechatOut).toBe(LAYOUT.ranks - 1)
  })

  it('sets a source right before the first box it feeds, so no arrow from a source crosses the page', () => {
    for (const node of NODES) {
      const out = EDGES.filter(edge => edge.from === node.id).map(edge => LAYOUT.rank[edge.to]!)
      if (EDGES.some(edge => edge.to === node.id) || out.length === 0) continue
      expect(LAYOUT.rank[node.id]!, node.id).toBe(Math.min(...out) - 1)
    }
  })

  it('gives every node a spot on the canvas and keeps nodes in a rank from overlapping', () => {
    for (const id of ids) {
      const at = LAYOUT.at[id]!
      expect(at.x).toBeGreaterThanOrEqual(0)
      expect(at.y).toBeGreaterThanOrEqual(0)
      expect(at.x + NODE_W).toBeLessThanOrEqual(LAYOUT.width)
      expect(at.y + NODE_H).toBeLessThanOrEqual(LAYOUT.height)
    }
    for (let rank = 0; rank < LAYOUT.ranks; rank += 1) {
      const column = ids.filter(id => LAYOUT.rank[id] === rank).map(id => LAYOUT.at[id]!.y).sort((a, b) => a - b)
      for (let i = 1; i < column.length; i += 1) expect(column[i]! - column[i - 1]!).toBeGreaterThanOrEqual(NODE_H)
    }
  })

  it('draws an edge from the right side of its source to the left side of its target', () => {
    const from = LAYOUT.at.amsGroup!
    const to = LAYOUT.at.repairQ!
    const path = edgePath('amsGroup', 'repairQ')
    expect(path.startsWith(`M${from.x + NODE_W} ${from.y + NODE_H / 2}`)).toBe(true)
    expect(path.endsWith(`${to.x} ${to.y + NODE_H / 2}`)).toBe(true)
  })

  it('writes an answer in the middle of its arrow', () => {
    const from = LAYOUT.at.repairQ!
    const to = LAYOUT.at.repair!
    const mid = edgeMid('repairQ', 'repair')
    expect(mid.x).toBeGreaterThan(from.x + NODE_W)
    expect(mid.x).toBeLessThan(to.x)
    expect(mid.y).toBeCloseTo((from.y + to.y) / 2 + NODE_H / 2)
  })
})

describe('relatives', () => {
  it('collects everything upstream and downstream of a node, and the edges between them', () => {
    const { nodes, edges } = relatives('repairQ')
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
    const { nodes } = relatives('wechatIn')
    expect(nodes.has('main')).toBe(true)
    expect(nodes.has('wechatOut')).toBe(true)
    expect(nodes.has('github')).toBe(false)
  })
})
