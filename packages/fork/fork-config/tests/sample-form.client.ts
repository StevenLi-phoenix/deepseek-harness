/** A hand-built form for the card tests: the field kinds the card edits, laid out as the Host answers them. */
import type { ConfigEntryView, FieldNode, LeafField } from '../src/view.ts'

type Patch = Partial<LeafField>

const leaf = (kind: LeafField['kind'], path: string[], over: Patch = {}): LeafField => ({
  kind, key: path.at(-1) as string, path, layer: 'default', required: false, ...over,
})

/** The sample form; `patches` change single leaves by dotted path, and `locked` is the home patch's lock. */
export function sampleForm(patches: Record<string, Patch> = {}, locked = false): FieldNode[] {
  const make = (kind: LeafField['kind'], path: string[], over: Patch = {}): LeafField => {
    const patched = { ...over, ...patches[path.join('.')] }
    return locked ? leaf(kind, path, { ...patched, layer: 'home', readOnly: kind === 'secret' ? 'secret' : 'home' }) : leaf(kind, path, patched)
  }
  return [
    make('string', ['url'], { layer: 'bundle', value: 'ws://a', default: 'ws://127.0.0.1:3001' }),
    make('credential-ref', ['tokenEnv'], { default: 'SAMPLE_TOKEN' }),
    make('secret', ['password'], { set: true, readOnly: 'secret' }),
    make('string-list', ['groups'], { default: [] }),
    {
      kind: 'group', key: 'media', path: ['media'], children: [
        make('boolean', ['media', 'images'], { default: true }),
        make('number', ['media', 'maxBytes'], { layer: 'bundle', value: 4096, default: 15_728_640, min: 1024, step: 1 }),
        make('string-list', ['media', 'hosts'], { default: ['qq.com'] }),
      ],
    },
    make('select', ['mode'], { default: 'fast', options: ['fast', 'slow'] }),
    make('json', ['extra']),
    make('string', ['note'], { description: 'Shown in the card' }),
  ]
}

/** An entry view over fields. */
export function entryView(id: string, fields: FieldNode[], over: Partial<ConfigEntryView> = {}): ConfigEntryView {
  const owners = JSON.stringify(fields).split('"layer":"owner"').length - 1
  return { id, found: true, active: true, locked: false, revision: 'r1', overrides: owners, fields, ...over }
}
