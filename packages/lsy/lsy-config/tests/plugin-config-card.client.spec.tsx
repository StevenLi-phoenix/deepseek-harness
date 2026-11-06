// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PluginConfigCard, type PluginConfigCardUsedProps, type PluginConfigTranslate } from '../src/client/PluginConfigCard.tsx'
import { createConfigStore, entryKey, type EntryState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'
import type {} from '../src/client/slot-contract.ts'
import { leavesOf, type ConfigEntryView, type FieldNode, type ConfigValue } from '../src/view.ts'
import { QQ_FORM } from './qq-form.client.ts'
import { entryView, sampleForm } from './sample-form.client.ts'
import type { LeafField } from '../src/view.ts'

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

function mount(
  entries: string[],
  states: Record<string, Partial<EntryState> & { view: ConfigEntryView | null }>,
  extra: { exclude?: string[]; reloadWarning?: string } = {},
) {
  const store = createConfigStore()
  store.update((draft) => {
    for (const [id, state] of Object.entries(states)) {
      (draft.entries as Record<string, EntryState>)[entryKey(id, extra.exclude)] = { phase: 'ready', refused: null, savedAt: null, ...state }
    }
  })
  const load = vi.fn()
  const save = vi.fn((..._args: unknown[]) => Promise.resolve(true))
  const locale = { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} }
  const props = {
    entries, t, load, save, ...extra,
    usePluginConfig: bindSnapshotSelector(store), useLocale: bindSnapshotSelector(locale),
  } satisfies PluginConfigCardUsedProps
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
    const { load } = mount(['lsy-qq', 'lsy-qq-login'], {})
    expect(load).toHaveBeenCalledWith(['lsy-qq', 'lsy-qq-login'], [])
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

  it('renders every field of the lsy-qq schema', () => {
    // The form the lsy-qq schema builds; schemas.spec.ts keeps this fixture equal to the schema.
    const view = entryView('lsy-qq', withValues(QQ_FORM))
    mount(['lsy-qq'], { 'lsy-qq': { view } })
    open('lsy-qq')
    expect(document.querySelectorAll('[data-path]')).toHaveLength(55)
    expect(control(within(row('groups')).getByRole('textbox')).value).toBe('1001')
    expect(control(within(row('media.retainDays')).getByRole('textbox')).value).toBe('7')
    expect(within(row('tokenEnv')).getByText('环境变量名；这里只显示名字，不读取它的值')).toBeTruthy()
    expect(screen.getByText('55 个字段')).toBeTruthy()
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
    expect(save).toHaveBeenCalledWith('sample', [], 'r1', [
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
    expect(save).toHaveBeenCalledWith('sample', [], 'r1', [{ op: 'unset', path: ['url'] }])
  })

  it('says reloading, and disables the form, until the plugin answers', () => {
    const view = entryView('sample', sampleForm())
    const { store } = mount(['sample'], { sample: { view, phase: 'reloading' } })
    open('sample')
    expect(screen.getByRole('status').textContent).toBe('正在重新载入…')
    expect(control(within(row('url')).getByRole('textbox')).disabled).toBe(true)
    act(() => { store.update((draft) => { (draft.entries as Record<string, EntryState>)[entryKey('sample')] = { view, phase: 'ready', refused: null, savedAt: 1 } }) })
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
    expect(load).toHaveBeenCalledWith(['sample'], [])
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

  it('never saves on its own: typing, blurring and waiting write nothing until the review is confirmed', () => {
    vi.useFakeTimers()
    const view = entryView('sample', sampleForm())
    const { save } = mount(['sample'], { sample: { view } })
    open('sample')
    const url = within(row('url')).getByRole('textbox')
    fireEvent.change(url, { target: { value: 'ws://typed' } })
    fireEvent.blur(url)
    fireEvent.click(within(row('media.images')).getByRole('switch'))
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    // The review is open and still nothing is written; going back keeps the drafts and writes nothing either.
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回修改' }))
    expect(control(within(row('url')).getByRole('textbox')).value).toBe('ws://typed')
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows the reload warning in the review of a save that reloads the plugin, and only there', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view } }, { reloadWarning: '保存会让观察器重连；请攒齐改动一次保存' })
    open('sample')
    expect(screen.queryByText('保存会让观察器重连；请攒齐改动一次保存')).toBeNull()
    fireEvent.change(within(row('url')).getByRole('textbox'), { target: { value: 'ws://b' } })
    expect(screen.queryByText('保存会让观察器重连；请攒齐改动一次保存')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const review = screen.getByRole('group', { name: '将要保存的改动' })
    expect(within(review).getByText('保存会让观察器重连；请攒齐改动一次保存')).toBeTruthy()
    expect(within(review).getByText('保存会写入你的配置补丁，并重新载入“sample”。')).toBeTruthy()
  })

  it('leaves the warning out, and says nothing reloads, when only volatile fields change', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view } }, { reloadWarning: '保存会让观察器重连' })
    open('sample')
    fireEvent.change(within(row('groups')).getByRole('textbox'), { target: { value: '1\n2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const review = screen.getByRole('group', { name: '将要保存的改动' })
    expect(within(review).queryByText('保存会让观察器重连')).toBeNull()
    expect(within(review).getByText('保存会写入你的配置补丁；这些改动立即生效，“sample”不会重新载入。')).toBeTruthy()
  })

  it('renders without a warning when the section passes none', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view } })
    open('sample')
    fireEvent.change(within(row('url')).getByRole('textbox'), { target: { value: 'ws://b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('reads, shows, and saves under the excluded fields it was given, and does not show them', async () => {
    const form = sampleForm().filter(node => node.key !== 'groups')
    const view = entryView('sample', form)
    const { load, save } = mount(['sample'], { sample: { view } }, { exclude: ['groups'] })
    open('sample')
    expect(load).toHaveBeenCalledWith(['sample'], ['groups'])
    expect(row('groups')).toBeNull()
    fireEvent.change(within(row('url')).getByRole('textbox'), { target: { value: 'ws://b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认保存' })) })
    expect(save).toHaveBeenCalledWith('sample', ['groups'], 'r1', [{ op: 'set', path: ['url'], value: 'ws://b' }])
  })
})

const leafOf = (kind: LeafField['kind'], path: string[], over: Partial<LeafField> = {}): LeafField => ({
  kind, key: path.at(-1) as string, path, layer: 'default', required: false, ...over,
})

describe('PluginConfigCard rows', () => {
  it('shows an unset credential as not set', () => {
    const view = entryView('e', [leafOf('secret', ['password'], { set: false, readOnly: 'secret' })])
    mount(['e'], { e: { view } })
    open('e')
    expect(within(row('password')).getByText('未设置')).toBeTruthy()
  })

  it('returns a staged reset of a switch to the layer below, and shows a staged switch position', () => {
    const view = entryView('e', [
      leafOf('boolean', ['on'], { layer: 'owner', value: false, base: true, default: false }),
      leafOf('boolean', ['plain'], { layer: 'owner', value: true, default: false }),
    ])
    mount(['e'], { e: { view } })
    open('e')
    expect(within(row('on')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(row('on')).getByRole('button', { name: '恢复默认' }))
    expect(within(row('on')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(row('plain')).getByRole('button', { name: '恢复默认' }))
    expect(within(row('plain')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(row('plain')).getByRole('switch'))
    expect(within(row('plain')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('stages a chosen option, offers a stored value no option matches, and prints object options as JSON', () => {
    const view = entryView('e', [
      leafOf('select', ['mode'], { value: 'fast', default: 'fast', options: ['fast', 'slow'] }),
      leafOf('select', ['legacy'], { value: 'old', options: ['new'] }),
      leafOf('select', ['shape'], { value: { a: 1 }, options: [{ a: 1 }, { a: 2 }] }),
      leafOf('select', ['empty'], {}),
      leafOf('select', ['optionless'], { value: 'x' }),
    ])
    const { save } = mount(['e'], { e: { view } })
    open('e')
    const select = (path: string): HTMLSelectElement => within(row(path)).getByRole('combobox') as HTMLSelectElement
    const optionTexts = (path: string): string[] => [...select(path).options].map(option => option.textContent ?? '')
    expect(optionTexts('mode')).toEqual(['fast', 'slow'])
    expect(optionTexts('legacy')).toEqual(['"old"', 'new'])
    expect(optionTexts('shape')).toEqual(['{"a":1}', '{"a":2}'])
    expect(optionTexts('empty')).toEqual([])
    expect(optionTexts('optionless')).toEqual(['"x"'])
    fireEvent.change(select('mode'), { target: { value: '"slow"' } })
    expect(select('mode').value).toBe('"slow"')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('mode：fast → slow')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('prints a staged clear and a reset in the review, with "none" for an empty side', async () => {
    const view = entryView('e', [
      leafOf('string', ['name'], { value: 'old' }),
      leafOf('string', ['fresh'], {}),
      leafOf('string', ['mine'], { layer: 'owner', value: 'mine' }),
    ])
    const { save } = mount(['e'], { e: { view } })
    open('e')
    fireEvent.change(within(row('name')).getByRole('textbox'), { target: { value: '' } })
    fireEvent.change(within(row('fresh')).getByRole('textbox'), { target: { value: 'new' } })
    fireEvent.click(within(row('mine')).getByRole('button', { name: '恢复默认' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const review = screen.getByRole('group', { name: '将要保存的改动' })
    expect(within(review).getAllByRole('listitem')[0]!.textContent).toBe('name：清除，改用默认 （未设置）')
    expect(within(review).getAllByRole('listitem')[1]!.textContent).toBe('fresh：（未设置） → new')
    expect(within(review).getAllByRole('listitem')[2]!.textContent).toBe('mine：恢复为 （未设置）')
    await act(async () => { fireEvent.click(within(review).getByRole('button', { name: '确认保存' })) })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('opens a group that holds owner overrides, counts them, and shows the group description', () => {
    const view = entryView('e', [
      { kind: 'group', key: 'g', path: ['g'], description: 'About the group', children: [leafOf('string', ['g', 'x'], { layer: 'owner', value: 'v' })] },
    ])
    mount(['e'], { e: { view } })
    const group = document.querySelector<HTMLDetailsElement>('[data-group="g"]')!
    expect(group.hasAttribute('open')).toBe(true)
    expect(within(group).getByText('1 项已改')).toBeTruthy()
    expect(within(group).getByText('About the group')).toBeTruthy()
  })
})

describe('PluginConfigCard status and saving', () => {
  it('says saving while the write is in flight', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view, phase: 'saving' } })
    expect(screen.getByRole('status').textContent).toBe('保存中…')
  })

  it('says the plugin did not come back, with a retry, after a timeout', () => {
    const view = entryView('sample', sampleForm())
    mount(['sample'], { sample: { view, phase: 'unreachable' } })
    expect(screen.getByRole('status').textContent).toContain('改动已写入，但插件还没有重新响应。')
  })

  it('keeps the staged edits and shows no saved note when the save did not land', async () => {
    const view = entryView('sample', sampleForm())
    const { save } = mount(['sample'], { sample: { view } })
    save.mockResolvedValueOnce(false)
    open('sample')
    fireEvent.change(within(row('url')).getByRole('textbox'), { target: { value: 'ws://b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认保存' })) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(control(within(row('url')).getByRole('textbox')).value).toBe('ws://b')
    expect(screen.queryByText('已保存，插件已重新载入。')).toBeNull()
  })

  it('shows the loading note while an entry has never been read, and the form of an entry that is already read', () => {
    const view = entryView('sample', sampleForm())
    mount(['pending', 'sample'], { pending: { view: null, phase: 'loading' }, sample: { view } })
    expect(screen.queryByText('正在读取…')).toBeNull()
    expect(document.querySelector('[data-entry="sample"]')).not.toBeNull()
    cleanup()
    mount(['pending'], { pending: { view: null, phase: 'loading' } })
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    cleanup()
    mount(['gone'], { gone: { view: null, phase: 'unreachable' } })
    expect(document.body.textContent).toBe('')
  })
})
