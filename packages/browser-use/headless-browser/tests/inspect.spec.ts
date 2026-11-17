/**
 * The reading rules, without a browser: what an eval result looks like when the
 * page answers with JSON, when it answers with something JSON cannot carry, and
 * when it answers with too much; and what an accessibility tree looks like once
 * hidden nodes, repeated text, state, and the node cap have shaped it.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AX_NODES, INTERACTIVE_ROLES, MAX_AX_CHARS, MAX_DIAGNOSTIC_CHARS, MAX_EXPRESSION_CHARS, MAX_RESULT_CHARS,
  evalText, expressionProblem, formatAxTree, pngSize, shapeEval, truncate, uniqueDiagnostics,
  type AxNode,
} from '../src/inspect.ts'

/** A tree with wrappers, a hidden subtree, repeated text, a value, and states. */
const FORM: AxNode[] = [
  { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Form' }, childIds: ['2'] },
  { nodeId: '2', ignored: true, role: { value: 'none' }, childIds: ['3', '4', '5'] },
  { nodeId: '3', ignored: false, role: { value: 'heading' }, name: { value: 'Sign in' }, backendDOMNodeId: 7, childIds: ['9'] },
  { nodeId: '9', ignored: false, role: { value: 'StaticText' }, name: { value: 'Sign in' }, backendDOMNodeId: 30 },
  {
    nodeId: '4',
    ignored: false,
    role: { value: 'textbox' },
    name: { value: 'Email ' },
    backendDOMNodeId: 10,
    properties: [{ name: 'disabled', value: { value: true } }, { name: 'required', value: { value: true } }],
  },
  {
    nodeId: '5',
    ignored: false,
    role: { value: 'combobox' },
    name: { value: 'Role' },
    value: { value: 'Admin' },
    backendDOMNodeId: 11,
    properties: [{ name: 'expanded', value: { value: false } }, { name: 'checked', value: { value: 'mixed' } }],
  },
]

/** Allocate `e1`, `e2`, ... in call order. */
function countingIds(): { idOf: (node: number) => string; seen: number[] } {
  const seen: number[] = []
  return {
    seen,
    idOf: (node) => {
      seen.push(node)
      return `e${String(seen.length)}`
    },
  }
}

describe('truncate', () => {
  it('keeps a short text and marks a long one', () => {
    expect(truncate('abc', 10)).toEqual({ text: 'abc', truncated: false, characters: 3 })
    const capped = truncate('abcdef', 3)
    expect(capped.truncated).toBe(true)
    expect(capped.characters).toBe(6)
    expect(capped.text).toBe('abc\n… [truncated: 3 more characters]')
  })
})

describe('evalText', () => {
  it('prints JSON, undefined, and the values JSON cannot carry', () => {
    expect(evalText({ type: 'number', value: 2 })).toBe('2')
    expect(evalText({ type: 'object', value: { a: 1, b: [true, null] } })).toBe('{"a":1,"b":[true,null]}')
    expect(evalText({ type: 'undefined' })).toBe('undefined')
    expect(evalText(undefined)).toBe('undefined')
    expect(evalText({ type: 'number', unserializableValue: 'Infinity' })).toBe('Infinity')
    expect(evalText({ type: 'bigint', unserializableValue: '5n' })).toBe('5n')
  })
})

describe('shapeEval', () => {
  it('caps a long result with a marker that names what was dropped', () => {
    const report = shapeEval({ url: 'https://example.test/', result: { type: 'string', value: 'x'.repeat(MAX_RESULT_CHARS + 25) } })
    expect(report.truncated).toBe(true)
    expect(report.characters).toBe(MAX_RESULT_CHARS + 27)
    expect(report.result.startsWith('"')).toBe(true)
    expect(report.result.endsWith('… [truncated: 27 more characters]')).toBe(true)
    expect(report.url).toBe('https://example.test/')
  })

  it('keeps a short result whole and quotes each diagnostic verbatim', () => {
    const report = shapeEval({
      url: 'about:blank',
      result: { type: 'object', value: { ok: true } },
      exceptions: ['ReferenceError: nothing is not defined\n    at <anonymous>:1:1'],
      consoleErrors: ['boom'],
    })
    expect(report.truncated).toBe(false)
    expect(report.result).toBe('{"ok":true}')
    expect(report.exceptions).toEqual(['ReferenceError: nothing is not defined\n    at <anonymous>:1:1'])
    expect(report.consoleErrors).toEqual(['boom'])
  })

  it('caps one very long diagnostic instead of the whole report', () => {
    const report = shapeEval({ url: 'about:blank', exceptions: ['x'.repeat(MAX_DIAGNOSTIC_CHARS + 5)] })
    expect(report.exceptions[0]).toContain('… [truncated: 5 more characters]')
  })
})

describe('uniqueDiagnostics', () => {
  it('drops the message that a stack already carries and keeps the new one', () => {
    expect(uniqueDiagnostics(['Error: nope\n    at <anonymous>:1:1', 'Error: nope', 'boom'])).toEqual([
      'Error: nope\n    at <anonymous>:1:1',
      'boom',
    ])
  })
})

describe('expressionProblem', () => {
  it('refuses an empty expression and one over the cap', () => {
    expect(expressionProblem('   ')).toBe('expression must not be empty')
    expect(expressionProblem('x'.repeat(MAX_EXPRESSION_CHARS + 1))).toContain(`at most ${String(MAX_EXPRESSION_CHARS)}`)
    expect(expressionProblem('document.title')).toBeUndefined()
  })
})

describe('formatAxTree', () => {
  it('prints roles, names, values, and states, skipping wrappers and repeated text', () => {
    const ids = countingIds()
    const shaped = formatAxTree(FORM, { idOf: ids.idOf })
    expect(shaped.text).toBe([
      'RootWebArea "Form"',
      '  heading "Sign in"',
      '  e1 textbox "Email" [disabled, required]',
      '  e2 combobox "Role" value="Admin" [checked=mixed, expanded=false]',
    ].join('\n'))
    expect(shaped.nodes).toBe(4)
    expect(shaped.interactive).toBe(2)
    expect(shaped.omitted).toBe(0)
    expect(shaped.truncated).toBe(false)
    // Ids are handed out per printed interactive node, in document order.
    expect(ids.seen).toEqual([10, 11])
  })

  it('gives every interactive role an id and no static role one', () => {
    const roles = [...INTERACTIVE_ROLES]
    const nodes: AxNode[] = [
      { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'roles' } },
      ...roles.map((role, index): AxNode => ({
        nodeId: `n${String(index + 1)}`,
        ignored: false,
        role: { value: role },
        name: { value: `${role} label` },
        backendDOMNodeId: 100 + index,
      })),
      { nodeId: 'text', ignored: false, role: { value: 'paragraph' }, name: { value: 'Body text' }, backendDOMNodeId: 999 },
    ]
    // The idle root has no children; link the roles under it so the tree is whole.
    nodes[0] = { ...nodes[0], childIds: nodes.slice(1).map(node => node.nodeId ?? '') }
    const ids = countingIds()
    const shaped = formatAxTree(nodes, { idOf: ids.idOf })
    const lines = shaped.text.split('\n')
    expect(shaped.interactive).toBe(roles.length)
    expect(lines).toHaveLength(roles.length + 2)
    expect(lines[0]).toBe('RootWebArea "roles"')
    expect(lines.slice(1, roles.length + 1).map(line => line.trim().split(' ')[0])).toEqual(
      roles.map((_role, index) => `e${String(index + 1)}`),
    )
    expect(lines.at(-1)).toBe('  paragraph "Body text"')
  })

  it('prints the states it knows and omits the ones that are off', () => {
    const nodes: AxNode[] = [{
      nodeId: '1',
      ignored: false,
      role: { value: 'switch' },
      name: { value: 'Notify' },
      backendDOMNodeId: 3,
      properties: [
        { name: 'checked', value: { value: 'true' } },
        { name: 'disabled', value: { value: false } },
        { name: 'expanded', value: { value: true } },
        { name: 'required', value: { value: true } },
      ],
    }]
    expect(formatAxTree(nodes).text).toBe('switch "Notify" [checked, expanded=true, required]')
  })

  it('caps the node count and reports the rest on one line', () => {
    const nodes: AxNode[] = [
      { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'list' } },
      ...[1, 2, 3, 4, 5].map((index): AxNode => ({
        nodeId: `n${String(index)}`,
        ignored: false,
        role: { value: 'link' },
        name: { value: `link ${String(index)}` },
        backendDOMNodeId: index,
      })),
    ]
    nodes[0] = { ...nodes[0], childIds: ['n1', 'n2', 'n3', 'n4', 'n5'] }
    const shaped = formatAxTree(nodes, { maxNodes: 3 })
    expect(shaped.nodes).toBe(3)
    expect(shaped.omitted).toBe(3)
    expect(shaped.interactive).toBe(2)
    expect(shaped.text.split('\n').at(-1)).toBe('… 3 more nodes')
  })

  it('stops at the default cap', () => {
    const nodes: AxNode[] = Array.from({ length: DEFAULT_AX_NODES + 4 }, (_entry, index): AxNode => ({
      nodeId: `n${String(index)}`,
      ignored: false,
      role: { value: 'link' },
      name: { value: `link ${String(index)}` },
      backendDOMNodeId: index,
    }))
    const shaped = formatAxTree(nodes)
    expect(shaped.nodes).toBe(DEFAULT_AX_NODES)
    expect(shaped.omitted).toBe(4)
  })

  it('caps the characters of one enormous tree', () => {
    const shaped = formatAxTree([{
      nodeId: '1',
      ignored: false,
      role: { value: 'paragraph' },
      name: { value: 'x'.repeat(MAX_AX_CHARS + 10) },
      backendDOMNodeId: 2,
    }])
    expect(shaped.truncated).toBe(true)
    expect(shaped.text).toContain('… [truncated:')
  })

  it('reads nothing out of an empty tree', () => {
    expect(formatAxTree([])).toEqual({ text: '', nodes: 0, interactive: 0, omitted: 0, truncated: false })
  })
})

describe('pngSize', () => {
  /** A PNG header with an IHDR chunk and the given size. */
  function header(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    new DataView(bytes.buffer).setUint32(16, width)
    new DataView(bytes.buffer).setUint32(20, height)
    return bytes
  }

  it('reads the size from a PNG header', () => {
    expect(pngSize(header(1280, 800))).toEqual({ width: 1280, height: 800 })
  })

  it('answers nothing for other bytes', () => {
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(pngSize(new TextEncoder().encode('not a png at all, honestly'))).toBeUndefined()
  })
})
