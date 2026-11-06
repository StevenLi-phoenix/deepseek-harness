/**
 * The "All settings" card: for each plugin entry a collapsible form of every Config field, grouped as the schema
 * nests them, each row showing the value in force, the layer that set it, and a reset to the layer below. Edits are
 * staged; the Save button opens a review of the changes, and only its confirmation writes (one write, one reload).
 * While the plugin reloads the form says so and keeps what was shown.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { SettingsForm, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: registers the fork.config locale namespace this component's `t` reads.
import type {} from './locales.ts'
import {
  countLeaves, initialText, pathKey, pickDescription, planEdits, shownValue, valueText,
  type Draft, type Drafts, type Plan,
} from './model.ts'
import type {} from './slot-contract.ts'
import { entryKey, type EntryState } from './store.ts'
import { leavesOf, type ConfigEntryView, type FieldNode, type LeafField } from '../view.ts'
import css from './PluginConfigCard.module.css'

/** Complete props of the factory component. */
export type PluginConfigCardProps = FactoryComponentPropsOf<'settings.plugin-config'>

/** The props the card reads; the factory passes the full set, a test passes only these. */
export type PluginConfigCardUsedProps = Pick<
  PluginConfigCardProps,
  'entries' | 'exclude' | 'reloadWarning' | 'usePluginConfig' | 'useLocale' | 'load' | 'save' | 't'
>

/** The card's translate function. */
export type PluginConfigTranslate = PluginConfigCardProps['t']

type Translate = PluginConfigTranslate

/** Shared by every row of one entry's form. */
interface FormContext {
  readonly t: Translate
  readonly locale: string
  readonly drafts: Drafts
  readonly disabled: boolean
  readonly invalid: ReadonlySet<string>
  readonly edit: (leaf: LeafField, draft: Draft | undefined) => void
}

function Row({ leaf, form }: { leaf: LeafField; form: FormContext }): ReactNode {
  const id = useId()
  const { t, drafts, disabled } = form
  const key = pathKey(leaf.path)
  const draft = drafts.get(key)
  const resetStaged = draft?.kind === 'reset'
  const readOnly = leaf.readOnly !== undefined
  const off = disabled || readOnly
  const invalid = form.invalid.has(key)
  const layerLabel = t(`layer.${leaf.layer}`)
  const textOf = (): string => {
    if (draft?.kind === 'text') return draft.text
    if (resetStaged) return valueText(leaf.kind, leaf.base ?? leaf.default)
    return initialText(leaf)
  }
  const edit = (text: string): void => { form.edit(leaf, { kind: 'text', text }) }
  const description = pickDescription(leaf.description, form.locale)
  const defaultText = leaf.default === undefined ? undefined : valueText(leaf.kind, leaf.default).replace(/\s+/g, ' ')

  let control: ReactNode
  if (leaf.kind === 'secret') {
    control = <Tag tone={leaf.set === true ? 'neutral' : 'quiet'}>{t(leaf.set === true ? 'secret.set' : 'secret.unset')}</Tag>
  } else if (leaf.kind === 'boolean') {
    const checked = draft?.kind === 'bool' ? draft.value : resetStaged ? (leaf.base ?? leaf.default) === true : shownValue(leaf) === true
    control = <Switch checked={checked} label={leaf.key} disabled={off} onChange={(next) => { form.edit(leaf, { kind: 'bool', value: next }) }} />
  } else if (leaf.kind === 'select') {
    control = (
      <select id={id} className={css.select} value={textOf()} disabled={off} onChange={(event) => { edit(event.target.value) }}>
        {textOf() === '' || (leaf.options ?? []).some(option => JSON.stringify(option) === textOf())
          ? null
          : <option value={textOf()}>{textOf()}</option>}
        {(leaf.options ?? []).map(option => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{typeof option === 'string' ? option : JSON.stringify(option)}</option>)}
      </select>
    )
  } else if (leaf.kind === 'string-list' || leaf.kind === 'json') {
    const text = textOf()
    control = (
      <textarea
        id={id} className={css.textarea} rows={Math.min(8, Math.max(2, text.split('\n').length))} spellCheck={false}
        value={text} disabled={off} aria-invalid={invalid} onChange={(event) => { edit(event.target.value) }}
      />
    )
  } else {
    control = (
      <input
        id={id} className={css.input} type="text" spellCheck={false} autoComplete="off"
        {...leaf.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
        value={textOf()} disabled={off} aria-invalid={invalid} onChange={(event) => { edit(event.target.value) }}
      />
    )
  }

  return (
    <div className={css.field} data-path={leaf.path.join('.')} data-layer={leaf.layer}>
      <div className={css.head}>
        <label className={css.label} htmlFor={id} title={leaf.path.join('.')}>{leaf.key}</label>
        <span className={css.badges}>
          <Tag tone={leaf.layer === 'owner' ? 'solid' : 'outline'}>{layerLabel}</Tag>
          {leaf.layer === 'owner' && !resetStaged && !readOnly
            ? <button type="button" className={css.reset} disabled={disabled} onClick={() => { form.edit(leaf, { kind: 'reset' }) }}>{t('field.reset')}</button>
            : null}
        </span>
      </div>
      {control}
      {invalid ? <p className={css.invalid}>{t('field.invalid')}</p> : null}
      {description === '' ? null : <p className={css.help}>{description}</p>}
      {leaf.kind === 'credential-ref' ? <p className={css.help}>{t('field.credentialRef')}</p> : null}
      {leaf.kind === 'string-list' ? <p className={css.help}>{t('field.listHint')}</p> : null}
      {leaf.kind === 'json' ? <p className={css.help}>{t('field.jsonHint')}</p> : null}
      {leaf.readOnly === undefined ? null : <p className={css.help}>{t(`readonly.${leaf.readOnly}`)}</p>}
      {leaf.kind === 'secret'
        ? null
        : <p className={css.help}>{defaultText === undefined ? t('field.noDefault') : t('field.default', { value: defaultText === '' ? t('field.unset') : defaultText })}</p>}
    </div>
  )
}

function Group({ node, form }: { node: FieldNode & { kind: 'group' }; form: FormContext }): ReactNode {
  const counts = countLeaves(node.children)
  const [open] = useState(() => counts.owner > 0)
  const description = pickDescription(node.description, form.locale)
  return (
    <details className={css.group} {...open ? { open: true } : {}} data-group={node.path.join('.')}>
      <summary className={css.groupSummary}>
        <span className={css.groupName}>{node.key}</span>
        <span className={css.meta}>
          {counts.owner > 0 ? <Tag tone="solid">{form.t('entry.overrides', { count: counts.owner })}</Tag> : null}
          {form.t('entry.fields', { count: counts.total })}
        </span>
      </summary>
      {description === '' ? null : <p className={css.help}>{description}</p>}
      <Nodes nodes={node.children} form={form} />
    </details>
  )
}

function Nodes({ nodes, form }: { nodes: readonly FieldNode[]; form: FormContext }): ReactNode {
  return nodes.map(node => node.kind === 'group'
    ? <Group key={pathKey(node.path)} node={node} form={form} />
    : <Row key={pathKey(node.path)} leaf={node} form={form} />)
}

interface ReviewProps {
  plan: Plan
  entry: string
  busy: boolean
  /** Text for a save that reloads the plugin. */
  warning: string | undefined
  t: Translate
  onConfirm: () => void
  onBack: () => void
}

function Review({ plan, entry, busy, warning, t, onConfirm, onBack }: ReviewProps): ReactNode {
  const none = t('review.none')
  return (
    <div className={css.review} role="group" aria-label={t('review.title')}>
      <span className={css.reviewTitle}>{t('review.title')}</span>
      <ul className={css.reviewList}>
        {plan.changes.map((change) => {
          const field = change.path.join('.')
          const before = change.before === '' ? none : change.before
          const after = change.after === '' ? none : change.after
          const key = change.action === 'set' ? 'review.set' : change.action === 'clear' ? 'review.clear' : 'review.reset'
          return <li key={change.key}>{t(key, { field, before, after })}</li>
        })}
      </ul>
      <p className={css.note}>{t(plan.reload ? 'review.note' : 'review.noteLive', { entry })}</p>
      {plan.reload && warning !== undefined && warning !== '' ? <p className={css.warning} role="note">{warning}</p> : null}
      <div className={css.reviewActions}>
        <button type="button" className={css.primary} disabled={busy} onClick={onConfirm}>{t('review.confirm')}</button>
        <button type="button" className={css.secondary} disabled={busy} onClick={onBack}>{t('review.back')}</button>
      </div>
    </div>
  )
}

function Status({ state, saved, retry, t }: { state: EntryState; saved: boolean; retry: () => void; t: Translate }): ReactNode {
  if (state.phase === 'saving') return <p className={css.status} role="status">{t('saving')}</p>
  if (state.phase === 'reloading') return <p className={css.status} role="status">{t('reloading')}</p>
  if (state.phase === 'unreachable') {
    return (
      <p className={css.status} role="status" data-tone="error">
        {t(state.view === null ? 'entry.unreachable' : 'reload.timeout')}
        <button type="button" className={css.link} onClick={retry}>{t('entry.retry')}</button>
      </p>
    )
  }
  if (state.refused !== null) {
    return <p className={css.status} role="alert" data-tone="error">{t(`refused.${state.refused.reason}`, { message: state.refused.message })}</p>
  }
  return saved ? <p className={css.status} role="status">{t('saved')}</p> : null
}

interface EntryFormProps {
  id: string
  exclude: readonly string[]
  reloadWarning: string | undefined
  state: EntryState
  locale: string
  t: Translate
  load: PluginConfigCardProps['load']
  save: PluginConfigCardProps['save']
}

function EntryForm({ id, exclude, reloadWarning, state, locale, t, load, save }: EntryFormProps): ReactNode {
  const view = state.view as ConfigEntryView
  const [drafts, setDrafts] = useState<Drafts>(new Map())
  const [reviewing, setReviewing] = useState(false)
  const [saved, setSaved] = useState(false)
  const plan = useMemo(() => planEdits(view, drafts), [view, drafts])
  const busy = state.phase === 'saving' || state.phase === 'reloading'
  const counts = countLeaves(view.fields)
  const invalid = useMemo(() => new Set(plan.invalid), [plan])

  const edit = (leaf: LeafField, draft: Draft | undefined): void => {
    setSaved(false)
    setReviewing(false)
    setDrafts((previous) => {
      const next = new Map(previous)
      if (draft === undefined) next.delete(pathKey(leaf.path))
      else next.set(pathKey(leaf.path), draft)
      return next
    })
  }
  const form: FormContext = { t, locale, drafts, disabled: busy || view.locked || reviewing, invalid, edit }
  const confirm = (): void => {
    setReviewing(false)
    void save(id, exclude, view.revision, plan.ops).then((landed) => {
      if (!landed) return
      setDrafts(new Map())
      setSaved(true)
    })
  }

  return (
    <details className={css.entry} data-entry={id}>
      <summary className={css.entrySummary}>
        <span className={css.entryName}>{id}</span>
        <span className={css.meta}>
          {view.overrides > 0 ? <Tag tone="solid">{t('entry.overrides', { count: view.overrides })}</Tag> : null}
          {t('entry.fields', { count: counts.total })}
        </span>
      </summary>
      {view.locked ? <p className={css.note}>{t('entry.locked')}</p> : null}
      <SettingsForm
        labels={{ unavailable: t('form.unavailable'), readOnly: t('form.readOnly'), saveFailed: t('form.saveFailed'), save: t('save'), saving: t('saving') }}
        state={{
          available: view.active,
          writable: true,
          dirty: plan.ops.length > 0 && !reviewing && !view.locked,
          invalid: plan.invalid.length > 0,
          saving: busy,
          failed: false,
        }}
        onSave={() => { setReviewing(true) }}
        onDiscard={() => { setDrafts(new Map()) }}
      >
        <Nodes nodes={view.fields} form={form} />
        {reviewing
          ? (
            <Review
              plan={plan} entry={id} busy={busy} warning={reloadWarning} t={t}
              onConfirm={confirm} onBack={() => { setReviewing(false) }}
            />
          )
          : null}
        <Status state={state} saved={saved} retry={() => { load([id], exclude) }} t={t} />
      </SettingsForm>
    </details>
  )
}

/**
 * Render the card for the entries a section names.
 * @param props - the entries, the store hook, the loader callbacks, and copy.
 * @returns the card, or nothing while no named entry has a form to show.
 */
export function PluginConfigCard(
  { entries, exclude: excluded, reloadWarning, usePluginConfig, useLocale, load, save, t }: PluginConfigCardUsedProps,
): ReactNode {
  const key = entries.join(',')
  const excludeKey = (excluded ?? []).join(',')
  const exclude = useMemo(() => excludeKey.split(',').filter(path => path !== ''), [excludeKey])
  const states = usePluginConfig(value => value.entries)
  const locale = useLocale(value => value.active)
  useEffect(() => { load(key.split(',').filter(id => id !== ''), exclude) }, [key, exclude, load])

  const stateOf = (id: string): EntryState | undefined => states[entryKey(id, exclude)]
  const shown = entries.filter((id) => {
    const view = stateOf(id)?.view
    return view !== null && view !== undefined && view.found && leavesOf(view.fields).length > 0
  })
  const reading = entries.some((id) => {
    const state = stateOf(id)
    return state === undefined || (state.phase === 'loading' && state.view === null)
  })
  const inactive = entries.filter((id) => {
    const view = stateOf(id)?.view
    return view !== null && view !== undefined && view.found && !view.active
  })
  if (shown.length === 0 && !reading && inactive.length === 0) return null
  return (
    <section className={css.card} aria-label={t('title')}>
      <span className={css.cardTitle}>{t('title')}</span>
      <p className={css.hint}>{t('hint')}</p>
      {shown.length === 0 && reading ? <p className={css.note} role="status">{t('entry.loading')}</p> : null}
      {inactive.map(id => <p key={id} className={css.note}>{`${id}: ${t('entry.inactive')}`}</p>)}
      {shown.map(id => (
        <EntryForm
          key={id} id={id} exclude={exclude} reloadWarning={reloadWarning} state={stateOf(id) as EntryState}
          locale={locale} t={t} load={load} save={save}
        />
      ))}
    </section>
  )
}
