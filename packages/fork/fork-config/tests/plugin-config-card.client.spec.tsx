// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PluginConfigCard, type PluginConfigCardProps, type PluginConfigTranslate } from '../src/client/PluginConfigCard.tsx'
import { createConfigStore, type EntryState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import { leavesOf, type ConfigEntryView, type FieldNode, type ConfigValue } from '../src/view.ts'
import { QQ_FORM } from './qq-form.client.ts'
import { entryView, sampleForm } from './sample-form.client.ts'

/** The fixture form with a few stored values, as a Host answer would carry them. */
function withValues(nodes: readonly FieldNode[]): FieldNode[] {
  const stored: Record<string, unknown> = { groups: ['1001'], 'media.retainDays': 7 }
  return nodes.map((node): FieldNode => {
    if (node.kind === 'group') return { ...node, children: withValues(node.children) }
    const value = stored[node.path.join('.')]
    return value === undefined ? node : { ...node, value: value as ConfigValue, layer: 'bundle' }
  })
}

const t = makeTranslate(zh) as PluginConfigTranslate

function mount(entries: string[], states: Record<string, Partial<EntryState> & { view: ConfigEntryView | null }>) {
  const store = createConfigStore()
  store.update((draft) => {
    for (const [id, state] of Object.entries(states)) {
      (draft.entries as Record<string, EntryState>)[id] = { phase: 'ready', refused: null, savedAt: null, ...state }
    }
  })
  const load = vi.fn()
  const save = vi.fn((..._args: unknown[]) => Promise.resolve(true))
  const locale = { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} }
  const props = {
    entries, t, load, save,
    usePluginConfig: bindSnapshotSelector(store), useLocale: bindSnapshotSelector(locale),
  } as unknown as PluginConfigCardProps
  const view = render(<PluginConfigCard {...props} />)
  return { store, load, save, view }
}

afterEach(() => { cleanup() })

const open = (id: string): HTMLElement => {
  const details = document.querySelector<HTMLDetailsElement>(`[data-entry="${id}"]`)!
  details.open = true
  document.querySelectorAll<HTMLDetailsElement>(`[data-entry="${id}"] details`).forEach((group) => { group.open = true })
  return details
}
/** A form control; `value` and `disabled` exist on all three. */
function control(node: HTMLElement): HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement {
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement)) {
    throw new TypeError(`${node.tagName} is not a form control`)
  }
  return node
}
const row = (path: string): HTMLElement => document.querySelector<HTMLElement>(`[data-path="${path}"]`)!

describe('PluginConfigCard', () => {
  it('asks the Host for the named entries when it appears', () => {
    const { load } = mount(['fork-qq', 'fork-qq-login'], {})
    expect(load).toHaveBeenCalledWith(['fork-qq', 'fork-qq-login'])
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
  })

  it('renders every field of the sample schema, grouped as it nests, each with its layer', () => {
    const view = entryView('sample', sampleForm({ url: { layer: 'owner', value: 'ws://owner', base: 'ws://bundle' } }))
    mount(['sample'], { sample: { view } })
    open('sample')
    const paths = [...document.querySelectorAll('[data-path]')].map(node => node.getAttribute('data-path'))
    expect(paths).toEqual(leavesOf(view.fields).map(leaf => leaf.path.join('.')))
    expect(document.querySelector('[data-group="media"]')!.querySelectorAll('[data-path]')).toHaveLength(3)
    expect(row('url').getAttribute('data-layer')).toBe('owner')
    expect(within(row('url')).getByText('我的补丁')).toBeTruthy()
    expect(within(row('media.maxBytes')).getByText('内置配置')).toBeTruthy()
    expect(within(row('note')).getByText('Shown in the card')).toBeTruthy()
    expect(within(row('note')).getByText('默认：未设置')).toBeTruthy()
  })

  it('renders every field of the fork-qq schema', () => {
    // The form the fork-qq schema builds; schemas.spec.ts keeps this fixture equal to the schema.
    const view = entryView('fork-qq', withValues(QQ_FORM))
    mount(['fork-qq'], { 'fork-qq': { view } })
    open('fork-qq')
    expect(document.querySelectorAll('[data-path]')).toHaveLength(43)
    expect(control(within(row('groups')).getByRole('textbox')).value).toBe('1001')
    expect(control(within(row('media.retainDays')).getByRole('textbox')).value).toBe('7')
    expect(within(row('tokenEnv')).getByText('环境变量名；这里只显示名字，不读取它的值')).toBeTruthy()
    expect(screen.getByText('43 个字段')).toBeTruthy()
  })

  it('shows a credential as set or not, never a value', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view } })
    open('sample')
    expect(within(row('password')).getByText('已设置')).toBeTruthy()
    expect(within(row('password')).queryByRole('textbox')).toBeNull()
    expect(document.body.textContent).not.toContain('private-value')
    expect(within(row('password')).getByText('凭据不在这里显示或修改')).toBeTruthy()
  })

  it('makes every field read-only, with the reason, when the home patch sets the entry', () => {
    const view = entryView('sample', sampleForm({}, true), { locked: true })
    mount(['sample'], { sample: { view } })
    open('sample')
    expect(screen.getByText('这个条目的配置由 home 补丁设置，这里只读；要改请改 home 补丁。')).toBeTruthy()
    expect(control(within(row('url')).getByRole('textbox')).disabled).toBe(true)
    expect(within(row('url')).getByText('home 补丁')).toBeTruthy()
    expect(within(row('url')).getByText('由 home 补丁设置，这里只读')).toBeTruthy()
    expect(control(screen.getByRole('button', { name: '保存' })).disabled).toBe(true)
  })

  it('stages edits, reviews them, and saves once with the staged revision and only the changed fields', async () => {
    const view = entryView('sample', sampleForm())
    const { save } = mount(['sample'], { sample: { view } })
    open('sample')
    const save1 = control(screen.getByRole('button', { name: '保存' }))
    expect(save1.disabled).toBe(true)
    fireEvent.change(within(row('url')).getByRole('textbox'), { target: { value: 'ws://b' } })
    fireEvent.change(within(row('media.maxBytes')).getByRole('textbox'), { target: { value: '8192' } })
    fireEvent.click(within(row('media.images')).getByRole('switch'))
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(save1)
    const review = screen.getByRole('group', { name: '将要保存的改动' })
    expect(within(review).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'url：ws://a → ws://b', 'media.images：true → false', 'media.maxBytes：4096 → 8192',
    ])
    expect(save).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: '确认保存' })) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('sample', 'r1', [
      { op: 'set', path: ['url'], value: 'ws://b' },
      { op: 'set', path: ['media', 'images'], value: false },
      { op: 'set', path: ['media', 'maxBytes'], value: 8192 },
    ])
    expect(screen.getByRole('status').textContent).toBe('已保存，插件已重新载入。')
  })

  it('blocks the save on a value the field does not accept', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view } })
    open('sample')
    fireEvent.change(within(row('media.maxBytes')).getByRole('textbox'), { target: { value: '5' } })
    expect(within(row('media.maxBytes')).getByText('这个值不符合要求')).toBeTruthy()
    expect(control(screen.getByRole('button', { name: '保存' })).disabled).toBe(true)
  })

  it('resets an owner-set field to the layer below, staged until saved', async () => {
    const view = entryView('sample', sampleForm({ url: { layer: 'owner', value: 'ws://owner', base: 'ws://bundle' } }))
    const { save } = mount(['sample'], { sample: { view } })
    open('sample')
    expect(within(row('media.maxBytes')).queryByRole('button', { name: '恢复默认' })).toBeNull()
    fireEvent.click(within(row('url')).getByRole('button', { name: '恢复默认' }))
    expect(control(within(row('url')).getByRole('textbox')).value).toBe('ws://bundle')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('url：恢复为 ws://bundle')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认保存' })) })
    expect(save).toHaveBeenCalledWith('sample', 'r1', [{ op: 'unset', path: ['url'] }])
  })

  it('says reloading, and disables the form, until the plugin answers', () => {
    const view = entryView('sample', sampleForm())
    const { store } = mount(['sample'], { sample: { view, phase: 'reloading' } })
    open('sample')
    expect(screen.getByRole('status').textContent).toBe('正在重新载入…')
    expect(control(within(row('url')).getByRole('textbox')).disabled).toBe(true)
    act(() => { store.update((draft) => { (draft.entries as Record<string, EntryState>)['sample'] = { view, phase: 'ready', refused: null, savedAt: 1 } }) })
    expect(screen.queryByText('正在重新载入…')).toBeNull()
    expect(control(within(row('url')).getByRole('textbox')).disabled).toBe(false)
  })

  it('names why a save was refused', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view, refused: { reason: 'invalid', message: 'bad value' } } })
    expect(screen.getByRole('alert').textContent).toBe('插件不接受这些值：bad value')
  })

  it('offers a retry when the plugin does not answer after a save', () => {
    const view = entryView('sample', sampleForm())
    const { load } = mount(['sample'], { sample: { view, phase: 'unreachable' } })
    load.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(load).toHaveBeenCalledWith(['sample'])
  })

  it('renders nothing for entries the Host does not run, and says so for one that is not active', () => {
    const missing: ConfigEntryView = { id: 'tool-bili', found: false, active: false, locked: false, revision: '', overrides: 0, fields: [] }
    const { view } = mount(['tool-bili'], { 'tool-bili': { view: missing } })
    expect(view.container.innerHTML).toBe('')
    cleanup()
    const stopped: ConfigEntryView = { ...missing, id: 'bili', found: true }
    mount(['bili'], { bili: { view: stopped } })
    expect(screen.getByText('bili: 这个插件当前没有运行，读不到它的设置。')).toBeTruthy()
  })
})
