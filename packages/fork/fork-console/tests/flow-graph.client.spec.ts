import { describe, expect, it } from 'vitest'
import { EDGES, LAYOUT, NODES, NODE_H, NODE_W, edgePath, relatives } from '../src/client/flow-graph.ts'
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

  it('leaves no node alone', () => {
    for (const id of ids) expect(EDGES.some(edge => edge.from === id || edge.to === id), id).toBe(true)
  })

  it('binds nodes only to services the overview knows', () => {
    for (const node of NODES) if (node.service !== undefined) expect(SERVICE_IDS).toContain(node.service)
  })

  it('has a title and a description in the dictionary for every node, and a heading for every rank', () => {
    for (const node of NODES) {
      expect(zh, node.id).toHaveProperty(`flow.node.${node.id}`)
      expect(zh, node.id).toHaveProperty(`flow.node.${node.id}.desc`)
    }
    for (let rank = 0; rank < LAYOUT.ranks; rank += 1) expect(zh, `rank ${rank}`).toHaveProperty(`flow.rank.${rank}`)
  })
})

describe('flow layout', () => {
  it('puts the sources first and the owner-facing outputs last', () => {
    expect(LAYOUT.rank.wechatIn).toBe(0)
    expect(LAYOUT.rank.github).toBe(0)
    expect(LAYOUT.rank.ingest).toBeGreaterThan(LAYOUT.rank.github!)
    expect(LAYOUT.rank.bus).toBeGreaterThan(LAYOUT.rank.ingest!)
    expect(LAYOUT.rank.wechatOut).toBe(LAYOUT.ranks - 1)
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
    const from = LAYOUT.at.ingest!
    const to = LAYOUT.at.bus!
    const path = edgePath('ingest', 'bus')
    expect(path.startsWith(`M${from.x + NODE_W} ${from.y + NODE_H / 2}`)).toBe(true)
    expect(path.endsWith(`${to.x} ${to.y + NODE_H / 2}`)).toBe(true)
  })
})

describe('relatives', () => {
  it('collects everything upstream and downstream of a node, and the edges between them', () => {
    const { nodes, edges } = relatives('bus')
    expect(nodes.has('bus')).toBe(true)
    expect(nodes.has('ingest')).toBe(true)
    expect(nodes.has('github')).toBe(true)
    expect(nodes.has('wechatOut')).toBe(true)
    expect(nodes.has('wechatIn')).toBe(false)
    expect(edges.has('ingest>bus')).toBe(true)
    expect(edges.has('github>bus')).toBe(true)
    expect(edges.has('wechatIn>main')).toBe(false)
  })

  it('keeps a source to its own descendants', () => {
    const { nodes } = relatives('wechatIn')
    expect(nodes.has('main')).toBe(true)
    expect(nodes.has('github')).toBe(false)
  })
})
