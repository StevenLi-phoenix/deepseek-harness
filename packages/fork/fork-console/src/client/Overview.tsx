/**
 * The Service overview settings section: one card per integrated service with a health dot, one status line, and a Manage link
 * that switches the open Settings panel to that service's section when it is registered. It polls while mounted and pauses while
 * the page is hidden; a card whose service is down turns red and nothing else changes. The model route card is built here from
 * the balance route, since fork-balance already resolves the provider keys on the Host.
 */

import { useEffect, useId, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: registers the fork.console locale namespace this component's `t` reads.
import type {} from './locales.ts'
import type { OverviewView, ServiceCard } from '../views.ts'
import { balanceCard, type BalanceSummary } from './balance.ts'
import { MANAGE_SECTION, factLines, statusText } from './cards.ts'
import { clock, type Translate } from './format.ts'
import { POLL_INTERVAL_MS, startPolling, type ResourceState } from './resource.ts'
import css from './Console.module.css'

/** The section's injected face (slot `inject`). */
export interface OverviewInjected {
  hooks: {
    /** The shared overview store. */
    overview: ObservableSnapshot<ResourceState<OverviewView>>
    /** The balance summary behind the model route card. */
    balance: ObservableSnapshot<ResourceState<BalanceSummary>>
  }
  /** One refresh of both resources; a request in flight is shared. */
  refresh: () => void
  /** Whether a section is registered, so only live links show. */
  canManage: (section: string) => boolean
}

/** Props delivered by the settings shell. */
export type OverviewProps = PropsRuntime<'settings.section'> & InjectFace<OverviewInjected> & PropsLocale<'fork.console'>

function ServiceCardView({ card, t, canManage, select, now }: {
  card: ServiceCard
  now: number
  t: Translate
  canManage: (section: string) => boolean
  select: ((section: string) => void) | undefined
}): ReactNode {
  const id = useId()
  const target = MANAGE_SECTION[card.id]
  const facts = factLines(card, t, now)
  return (
    <section className={css.card} aria-labelledby={id} data-service={card.id} data-tone={card.tone}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>
          <span className={css.dot} data-tone={card.tone} aria-hidden="true" />
          {t(`card.${card.id}.title`)}
        </span>
      </div>
      <span className={css.line}>{statusText(card, t)}</span>
      {facts.length === 0 ? null : <div className={css.facts}>{facts.map(line => <span key={line}>{line}</span>)}</div>}
      {target !== undefined && canManage(target)
        ? (
          <div className={css.cardFooter}>
            <button type="button" className={css.button} onClick={() => { select?.(target) }}>{t('common.manage')}</button>
          </div>
        )
        : null}
    </section>
  )
}

/**
 * Render the Service overview section.
 * @param props - the store hooks, callbacks, and copy.
 * @returns the section.
 */
export function OverviewSection({ useOverview, useBalance, refresh, canManage, select, t }: OverviewProps): ReactNode {
  const state = useOverview(value => value)
  const balance = useBalance(value => value)
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])

  const translate = t as Translate
  const view = state.data
  const cards = view === null ? [] : [...view.cards, balanceCard(balance.data, balance.stale)]
  /* v8 ignore next -- the cards that use it exist only with a view. */
  const now = view?.checkedAt ?? 0
  const tone = state.checkedAt === null ? 'loading' : state.stale ? 'stale' : 'live'
  const text = state.checkedAt === null
    ? translate('status.loading')
    : view === null
      ? translate('status.failed')
      : state.stale ? translate('status.stale', { time: clock(view.checkedAt) }) : translate('status.live', { time: clock(view.checkedAt) })
  return (
    <section className={css.section} aria-label={translate('title.overview')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={tone} aria-hidden="true" />
          {text}
        </span>
        <span>{translate('overview.hint')}</span>
      </div>
      {cards.length === 0
        ? null
        : (
          <div className={css.grid}>
            {cards.map(card => (
              <ServiceCardView key={card.id} card={card} t={translate} canManage={canManage} select={select} now={now} />
            ))}
          </div>
        )}
    </section>
  )
}
