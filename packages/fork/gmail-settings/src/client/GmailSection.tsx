/**
 * Settings → 邮箱, in the order the owner needs it: a one-line summary and the last action's outcome; the messages
 * waiting for confirmation, when there are any; the accounts with the add-account form; the Google OAuth client
 * (above the accounts until it is configured); the send rules; collapsed, the recently handled messages and the
 * activity; and, at the foot, the All settings card of `gmail` (trusted recipients, cap, expiry). It refreshes
 * while open and pauses while the page is hidden.
 */

import { useEffect, useId, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: declares the 'settings.plugin-config' factory this section renders at its foot.
import type {} from '@deepseek-ai/dsh-plugin-config/client'
import type { GmailAction, GmailView } from '../view.ts'
// Type-only: registers the gmail locale namespace this component's `t` reads.
import type {} from './locales.ts'
import { AccountsGroup } from './Accounts.tsx'
import { ClientCard } from './ClientCard.tsx'
import {
  POLL_INTERVAL_MS, activityKind, activityWarns, doneLine, heldRows, resolvedRows, timeFormatter, type GmailState, type Translate,
} from './gmail.ts'
import { HeldGroup, Resolved } from './Held.tsx'
import { addressList, type PartProps } from './parts.tsx'
import { startPolling } from './polling.ts'
import css from './GmailSection.module.css'

/** The section's injected face (slot `inject`). */
export interface GmailInjected {
  hooks: {
    /** The shared section store. */
    gmail: ObservableSnapshot<GmailState>
  }
  /** One refresh; a request in flight is shared. */
  refresh: () => void
  /** Post an action; resolves to whether the Host did it. `control` names where its pending state and failure show. */
  act: (action: GmailAction, control?: string) => Promise<boolean>
  /** Write text to the clipboard; rejects where the browser withholds it. */
  copy: (text: string) => Promise<void>
  /** This page's origin, for the default redirect URI. */
  origin: string
}

/** Props delivered by the settings shell. */
export type GmailProps = PropsRuntime<'settings.section'> & InjectFace<GmailInjected> & PropsLocale<'gmail'>
  & Partial<PropsRenderFactories>

/** The plugin row whose configuration the All settings card edits. */
const CONFIG_ENTRIES = ['gmail'] as const

function Summary({ view, held, t }: { view: GmailView; held: number; t: Translate }): ReactNode {
  const reconnect = view.accounts.filter(account => account.needsReconnect).length
  const facts = [view.accounts.length === 0 ? t('summary.noAccounts') : t('summary.accounts', { count: view.accounts.length })]
  if (held > 0) facts.push(t('summary.held', { count: held }))
  if (reconnect > 0) facts.push(t('summary.reconnect', { count: reconnect }))
  const tone = held > 0 || reconnect > 0 ? 'warn' : view.accounts.length > 0 ? 'on' : 'off'
  return (
    <div className={css.header}>
      <span className={css.status} role="status">
        <span className={css.dot} data-tone={tone} aria-hidden="true" />
        {facts.join(' · ')}
      </span>
    </div>
  )
}

function RulesCard({ view, t }: { view: GmailView; t: Translate }): ReactNode {
  const titleId = useId()
  return (
    <section className={css.card} aria-labelledby={titleId}>
      <span id={titleId} className={css.cardTitle}>{t('rules.title')}</span>
      <ul className={css.bullets}>
        <li>{view.trustedRecipients.length === 0 ? t('rules.trustedNone') : t('rules.trusted', { list: addressList(view.trustedRecipients) })}</li>
        <li>{t('rules.accounts')}</li>
        <li>{t('rules.cap', { count: view.maxSendsPerDay })}</li>
        <li>{t('rules.ttl', { hours: view.confirmTtlHours })}</li>
      </ul>
      <span className={css.hint}>{t('rules.edit')}</span>
    </section>
  )
}

function ActivityCard({ view, t, clock }: { view: GmailView; t: Translate; clock: (at: number) => string }): ReactNode {
  return (
    <details className={css.card}>
      <summary className={css.summary}>
        <span className={css.cardTitle}>{t('activity.title')}</span>
        <span className={css.meta}>{t('activity.count', { count: view.activity.length })}</span>
      </summary>
      {view.activity.length === 0
        ? <span className={css.meta}>{t('activity.empty')}</span>
        : (
          <ul className={css.list}>
            {view.activity.map(row => (
              <li key={row.seq} className={css.activityRow} data-tone={activityWarns(row.kind) ? 'warn' : undefined}>
                <span className={css.meta}>{clock(row.at)}</span>
                <span className={css.accountTag}>{row.account}</span>
                <span className={css.kind}>{activityKind(row.kind, t)}</span>
                <span className={css.detail}>{row.detail}</span>
              </li>
            ))}
          </ul>
        )}
    </details>
  )
}

/**
 * Render the Gmail section.
 * @param props - the store hook, the refresh, action, and clipboard callbacks, the page origin, and copy.
 * @returns the section.
 */
export function GmailSection({ useGmail, refresh, act, copy, origin, renderFactorySlot, t }: GmailProps): ReactNode {
  const state = useGmail(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  const translate: Translate = t
  const { view } = state
  if (view === null) {
    return (
      <section className={css.section} aria-label={translate('title')}>
        <span className={css.status} role="status">{state.stale ? translate('status.failed') : translate('status.loading')}</span>
        {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
      </section>
    )
  }
  const parts: PartProps = { view, at: state.at, busy: state.busy, failure: state.failure, t: translate, act, clock: timeFormatter() }
  const held = heldRows(view)
  const handled = <Resolved rows={resolvedRows(view)} parts={parts} />
  const setup = !view.client.configured
  const client = <ClientCard parts={parts} origin={origin} copy={copy} />
  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <Summary view={view} held={held.length} t={translate} />
      {state.stale ? <p className={css.notice} role="status">{translate('status.stale')}</p> : null}
      {state.done === null ? null : <p className={css.done} role="status">{doneLine(state.done, translate)}</p>}
      {held.length > 0 ? <HeldGroup rows={held} parts={parts} /> : null}
      {held.length > 0 ? handled : null}
      {setup ? client : null}
      <AccountsGroup parts={parts} />
      {setup ? null : client}
      <RulesCard view={view} t={translate} />
      {held.length > 0 ? null : handled}
      <ActivityCard view={view} t={translate} clock={parts.clock} />
      {renderFactorySlot?.('settings.plugin-config', { entries: CONFIG_ENTRIES })}
    </section>
  )
}
