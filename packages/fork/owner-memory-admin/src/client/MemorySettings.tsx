/**
 * The Memory settings section: what the agent remembers about the owner, and the controls to review it. A
 * card of waiting writes on top (approve or discard, one at a time or all), the entries with search, filter,
 * and details on demand, a rollback card (pick a Session or a time, preview, confirm), and the feedback
 * verdicts. It polls while mounted, which the settings shell does only while the section is the open one,
 * and pauses while the page is hidden. A failed refresh keeps the last reading and says so quietly.
 */

import { useEffect, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the 'settings.plugin-config' factory (the All settings card).
import type {} from '@deepseek-ai/dsh-plugin-config/client'
// Type-only: registers the owner-memory locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { EntriesCard } from './EntriesCard.tsx'
import { FeedbackCard } from './FeedbackCard.tsx'
import { GuardCard } from './GuardCard.tsx'
import { POLL_INTERVAL_MS, startPolling, type MemoryActions, type MemoryState } from './memory.ts'
import { Button, type Translate } from './parts.tsx'
import { PendingCard } from './PendingCard.tsx'
import { RollbackCard } from './RollbackCard.tsx'
import css from './Memory.module.css'

/** Plugin entries whose configuration the All settings card lists on this page: the content guard's. */
const CONFIG_ENTRIES = ['content-guard'] as const

/** The section's injected face (slot `inject`). */
export interface MemoryInjected {
  hooks: {
    /** The shared memory store. */
    memory: ObservableSnapshot<MemoryState>
  }
  /** The owner's actions; stable for the registration's lifetime. */
  actions: MemoryActions
}

/** Props delivered by the settings shell. */
export type MemoryProps = PropsRuntime<'settings.section'> & InjectFace<MemoryInjected> & PropsLocale<'owner-memory'> & Partial<PropsRenderFactories>

/** What the header says about the last read. */
function statusLine(state: MemoryState, t: Translate): { text: string; tone: 'live' | 'stale' | 'idle' } {
  if (state.checkedAt === null) return { text: t('status.loading'), tone: 'idle' }
  const time = new Date(state.checkedAt).toLocaleTimeString()
  if (state.view === null) return { text: t('status.failed'), tone: 'stale' }
  return state.stale ? { text: t('status.stale', { time }), tone: 'stale' } : { text: t('status.live', { time }), tone: 'live' }
}

/**
 * Render the Memory section.
 * @param props - the store hook, the actions, and copy.
 * @returns the section.
 */
export function MemorySection({ useMemory, actions, renderFactorySlot, t }: MemoryProps): ReactNode {
  const state = useMemory(value => value)
  useEffect(() => startPolling(() => { void actions.refresh() }, POLL_INTERVAL_MS), [actions])
  const translate = t as Translate
  const status = statusLine(state, translate)
  const { view } = state
  const waiting = (view?.pending ?? []).filter(item => !state.hiding.includes(item.id)).length
  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
        {view === null ? null : <span className={css.summary}>{translate('summary', { total: view.total, pending: waiting })}</span>}
      </div>
      {state.error === null
        ? null
        : (
          <div className={css.error} role="alert">
            <span>{state.error.code === 'stale_preview' ? translate('error.stale_preview') : translate('error.failed', { message: state.error.message })}</span>
            <Button onClick={() => { actions.dismissError() }}>{translate('error.dismiss')}</Button>
          </div>
        )}
      {view === null
        ? null
        : (
          <>
            <PendingCard state={state} actions={actions} t={translate} />
            <EntriesCard state={state} actions={actions} t={translate} />
            <RollbackCard state={state} actions={actions} t={translate} />
            <FeedbackCard state={state} actions={actions} t={translate} />
          </>
        )}
      <GuardCard state={state} t={translate} />
      {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
    </section>
  )
}
