/**
 * The messages waiting for the owner: one card each with what the decision needs (the account, the sender, every
 * recipient with Bcc set apart, the subject, the attachments, the start of the text, why it waits, who started it,
 * and the time left), a 发送 that first restates the recipients and posts only on the second click, and 丢弃. The
 * latest resolved messages follow, collapsed.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { PendingRow } from '../view.ts'
import { expiresAt, expiresSoon, relative, type Translate } from './gmail.ts'
import type { GmailKey } from './locales.ts'
import { ActionError, Field, addressList, type PartProps } from './parts.tsx'
import css from './GmailSection.module.css'

const STATUS_KEY = {
  held: 'resolved.status.held',
  sent: 'resolved.status.sent',
  discarded: 'resolved.status.discarded',
  expired: 'resolved.status.expired',
} as const satisfies Record<PendingRow['status'], GmailKey>

const RESOLVED_BY_KEY = {
  'settings': 'resolved.by.settings',
  'owner-turn': 'resolved.by.owner-turn',
  'expiry': 'resolved.by.expiry',
} as const satisfies Record<NonNullable<PendingRow['resolvedBy']>, GmailKey>

function subjectOf(row: PendingRow, t: Translate): string {
  return row.subject === '' ? t('held.noSubject') : row.subject
}

/** The second step of 发送: the recipients again, Bcc included, and the button that posts. */
function ConfirmSend({ row, parts, onCancel }: { row: PendingRow; parts: PartProps; onCancel: () => void }): ReactNode {
  const { busy, t, act } = parts
  const panel = useRef<HTMLDivElement>(null)
  // The 发送 button that opened the panel is gone; keep the keyboard on the panel, not on the button that posts.
  useEffect(() => { panel.current?.focus() }, [])
  const sending = busy === `confirm:${row.code}`
  return (
    <div
      ref={panel}
      className={css.confirm}
      role="group"
      aria-label={t('held.confirmTitle')}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape' && !sending) onCancel() }}
    >
      <span className={css.confirmTitle}>{t('held.confirmTitle')}</span>
      <span>{t('held.confirmTo', { list: addressList(row.to) })}</span>
      {row.cc.length > 0 ? <span>{t('held.confirmCc', { list: addressList(row.cc) })}</span> : null}
      {row.bcc.length > 0
        ? <span className={css.bccLine}>{t('held.confirmBcc', { list: addressList(row.bcc) })}</span>
        : <span className={css.meta}>{t('held.confirmNoBcc')}</span>}
      <div className={css.actions}>
        <button
          type="button"
          className={css.primary}
          disabled={busy !== null}
          aria-busy={sending ? true : undefined}
          onClick={() => { void act({ action: 'confirm', code: row.code }) }}
        >
          {sending ? t('held.sending') : t('held.confirmGo')}
        </button>
        <button type="button" className={css.secondary} disabled={sending} onClick={onCancel}>{t('held.confirmCancel')}</button>
      </div>
    </div>
  )
}

function HeldCard({ row, parts }: { row: PendingRow; parts: PartProps }): ReactNode {
  const { view, at, busy, failure, t, act, clock } = parts
  const [confirming, setConfirming] = useState(false)
  const titleId = useId()
  const discard = `discard:${row.code}`
  const expires = expiresAt(row, view.confirmTtlHours)
  return (
    <article className={css.card} aria-labelledby={titleId} data-tone="held">
      <div className={css.cardHeader}>
        <span id={titleId} className={css.subject}>{subjectOf(row, t)}</span>
        <span className={css.code}>{t('held.code', { code: row.code })}</span>
      </div>
      <dl className={css.fields}>
        <Field label={t('held.account')}>{row.account}</Field>
        <Field label={t('held.from')}>{row.from}</Field>
        <Field label={t('held.to')}>{addressList(row.to)}</Field>
        {row.cc.length > 0 ? <Field label={t('held.cc')}>{addressList(row.cc)}</Field> : null}
        {row.bcc.length > 0
          ? (
            <Field label={t('held.bcc')} tone="bcc">
              <span className={css.bccList}>{addressList(row.bcc)}</span>
              <span className={css.bccNote}>{t('held.bccNote')}</span>
            </Field>
          )
          : null}
        {row.attachments.length > 0 ? <Field label={t('held.attachments')}>{addressList(row.attachments)}</Field> : null}
      </dl>
      <pre className={css.preview}>{row.preview === '' ? t('held.noPreview') : row.preview}</pre>
      <dl className={css.fields}>
        <Field label={t('held.reason')}>{row.reason}</Field>
        <Field label={t('held.origin')}>{row.origin}</Field>
      </dl>
      <span className={css.meta}>
        {t('held.created', { time: clock(row.createdAt) })}
        {' · '}
        <span className={expiresSoon(expires - at) ? css.warnText : undefined}>
          {expires > at ? t('held.expires', { left: relative(expires, at, t) }) : t('held.expired')}
        </span>
      </span>
      {row.noticeSent ? <span className={css.meta}>{t('held.noticeSent')}</span> : <span className={css.warnText}>{t('held.noticeMissing')}</span>}
      {confirming
        ? <ConfirmSend row={row} parts={parts} onCancel={() => { setConfirming(false) }} />
        : (
          <div className={css.actions}>
            <button type="button" className={css.primary} disabled={busy !== null} onClick={() => { setConfirming(true) }}>{t('held.send')}</button>
            <button
              type="button"
              className={css.secondary}
              disabled={busy !== null}
              aria-busy={busy === discard ? true : undefined}
              onClick={() => { void act({ action: 'discard', code: row.code }) }}
            >
              {busy === discard ? t('held.discarding') : t('held.discard')}
            </button>
          </div>
        )}
      <span className={css.hint}>{t('held.codeHint')}</span>
      <ActionError failure={failure} controls={[`confirm:${row.code}`, discard]} t={t} />
    </article>
  )
}

/**
 * The held messages, oldest first.
 * @param props - the held rows and the section's parts.
 * @returns the group.
 */
export function HeldGroup({ rows, parts }: { rows: readonly PendingRow[]; parts: PartProps }): ReactNode {
  const { t } = parts
  const titleId = useId()
  return (
    <section className={css.group} aria-labelledby={titleId}>
      <div className={css.groupHeader}>
        <span id={titleId} className={css.groupTitle}>{t('held.title')}</span>
        <span className={css.meta}>{t('held.count', { count: rows.length })}</span>
      </div>
      {rows.map(row => <HeldCard key={row.code} row={row} parts={parts} />)}
    </section>
  )
}

function resolvedFacts(row: PendingRow, { t, clock }: PartProps): string[] {
  const facts = [t(STATUS_KEY[row.status]), row.account, addressList([...row.to, ...row.cc, ...row.bcc])]
  if (row.resolvedAt !== null) facts.push(clock(row.resolvedAt))
  if (row.resolvedBy !== null) facts.push(t(RESOLVED_BY_KEY[row.resolvedBy]))
  return facts
}

/**
 * The latest resolved messages, collapsed; nothing when there are none.
 * @param props - the resolved rows and the section's parts.
 * @returns the disclosure, or null.
 */
export function Resolved({ rows, parts }: { rows: readonly PendingRow[]; parts: PartProps }): ReactNode {
  const { t } = parts
  if (rows.length === 0) return null
  return (
    <details className={css.card}>
      <summary className={css.summary}>
        <span className={css.cardTitle}>{t('resolved.title')}</span>
        <span className={css.meta}>{t('resolved.count', { count: rows.length })}</span>
      </summary>
      <ul className={css.list}>
        {rows.map(row => (
          <li key={row.code} className={css.row} data-status={row.status}>
            <span className={css.rowTitle}>{subjectOf(row, t)}</span>
            <span className={css.meta}>{resolvedFacts(row, parts).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
