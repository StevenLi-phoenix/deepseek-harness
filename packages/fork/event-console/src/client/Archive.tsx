/**
 * The auto-archive card of the Subscriptions section: whether the event bus archives idle chat Sessions, its rule and next
 * check, the last sweep with what it skipped and why, the recently archived Sessions, and the bus's own settings (the
 * plugin-config card, restricted to the auto-archive fields). The two buttons answer at once: the label turns into "Checking…"
 * and both stay disabled until the Host answers, and the next poll or the answer brings the new list.
 */

import type { ReactNode } from 'react'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the 'settings.plugin-config' factory this card renders at its foot.
import type {} from '@deepseek-ai/dsh-plugin-config/client'
import type { ArchivedRow, ArchiveSweepView, ArchiveView } from '../views.ts'
import { ago, stamp, until, type Translate } from './format.ts'
import type { ConsoleKey } from './locales.ts'
import css from './Console.module.css'

/** The bus entry whose settings the card lists. */
export const ARCHIVE_CONFIG_ENTRIES = ['event-bus'] as const

/** Bus settings that are not the auto-archive's: the subscriptions are read on this page, the rest is plumbing. */
export const ARCHIVE_CONFIG_EXCLUDE = [
  'subscriptions', 'suppress', 'retainEvents', 'retainBatches', 'maxTextChars', 'notifySessionResult', 'reportScheduledTurns',
  'maxNoteEvents', 'webUrl',
] as const

/** Skip reasons the Host names itself; any other reason is a plugin's label (`wechat`, `qq`) and shows as it is. */
const KNOWN_SKIPS = new Set(['recent', 'unknown', 'persistent', 'subscription', 'running', 'pinned', 'subagent', 'active', 'overLimit'])

/** Which button is waiting for the Host. */
export type ArchiveBusy = 'preview' | 'sweep' | null

const skipLabel = (reason: string, t: Translate): string => (KNOWN_SKIPS.has(reason) ? t(`subs.archive.skip.${reason}` as ConsoleKey) : reason)

/** Skip counts as `reason n`, largest first, without the Sessions that were simply recent. */
function skippedText(skipped: Readonly<Record<string, number>>, t: Translate): string {
  return Object.entries(skipped)
    .filter(([reason, count]) => reason !== 'recent' && count > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `${skipLabel(reason, t)} ${count}`)
    .join(' · ')
}

function SessionRow({ row, now, preview, t }: { row: ArchivedRow; now: number; preview: boolean; t: Translate }): ReactNode {
  const name = row.title ?? t('subs.archive.untitled', { id: row.id.slice(0, 8) })
  const meta = preview || row.archivedAt === null
    ? t('subs.archive.row.preview', { last: ago(row.lastActiveAt, now, t) })
    : t('subs.archive.row', { last: ago(row.lastActiveAt, now, t), when: ago(row.archivedAt, now, t) })
  return (
    <div className={css.row} data-archived={row.id}>
      <div className={css.rowMain}>
        <span className={css.rowTitle}>{name}</span>
        <span className={css.meta}>{meta}</span>
      </div>
    </div>
  )
}

function LastSweep({ last, now, t }: { last: ArchiveSweepView; now: number; t: Translate }): ReactNode {
  const when = `${ago(last.at, now, t)} (${stamp(last.at)})`
  const line = last.aborted !== null
    ? t('subs.archive.last.aborted', { when, reason: last.aborted })
    : t(last.dryRun ? 'subs.archive.last.dry' : 'subs.archive.last.ran', { when, scanned: last.scanned, archived: last.archived })
  const skipped = skippedText(last.skipped, t)
  return (
    <div className={css.rowMain} data-scope="archive-last">
      <span className={css.meta}>{line}</span>
      {skipped === '' ? null : <span className={css.meta}>{t('subs.archive.skipped', { list: skipped })}</span>}
      {last.errors > 0 ? <span className={css.meta}>{t('subs.archive.last.errors', { count: last.errors })}</span> : null}
    </div>
  )
}

/**
 * Render the auto-archive card.
 * @param props - the Host's archive view (null when the bus is not mounted), the clock, the copy, and the sweep trigger.
 * @returns the card.
 */
export function ArchiveCard({ archive, now, t, busy, onSweep, renderFactorySlot }: {
  archive: ArchiveView | null
  now: number
  t: Translate
  busy: ArchiveBusy
  onSweep: (dryRun: boolean) => void
  renderFactorySlot: PropsRenderFactories['renderFactorySlot'] | undefined
}): ReactNode {
  return (
    <div data-scope="archive">
      <div className={css.heading}>
        <span className={css.headingTitle}>{t('subs.archive.title')}</span>
        {archive === null
          ? null
          : (
            <span className={css.rowActions}>
              <button type="button" className={css.button} disabled={busy !== null} onClick={() => { onSweep(true) }}>
                {busy === 'preview' ? t('subs.archive.working') : t('subs.archive.preview')}
              </button>
              <button type="button" className={css.button} data-kind="primary" disabled={busy !== null || !archive.enabled} onClick={() => { onSweep(false) }}>
                {busy === 'sweep' ? t('subs.archive.working') : t('subs.archive.sweep')}
              </button>
            </span>
          )}
      </div>
      <span className={css.hint}>{t('subs.archive.hint')}</span>
      {archive === null
        ? <div className={css.rows}><div className={css.empty}>{t('subs.archive.unavailable')}</div></div>
        : (
          <div className={css.rows}>
            <div className={css.row} data-scope="archive-state">
              <div className={css.rowMain}>
                <span className={css.rowTitle}>
                  {t(archive.enabled ? (archive.dryRun ? 'subs.archive.state.dry' : 'subs.archive.state.on') : 'subs.archive.state.off')}
                  <span className={css.badge} data-kind={archive.enabled ? undefined : 'paused'}>
                    {t('subs.archive.rule', { days: archive.inactiveDays, max: archive.maxPerSweep, hours: archive.sweepHours })}
                  </span>
                </span>
                {archive.nextSweepAt === null
                  ? null
                  : <span className={css.meta}>{t('subs.archive.next', { when: `${until(archive.nextSweepAt, now, t)} (${stamp(archive.nextSweepAt)})` })}</span>}
                {archive.protectors.length === 0
                  ? null
                  : <span className={css.meta}>{t('subs.archive.protected', { list: archive.protectors.join(', ') })}</span>}
              </div>
            </div>
            {archive.last === null ? null : <div className={css.row}><LastSweep last={archive.last} now={now} t={t} /></div>}
          </div>
        )}
      {archive?.last?.dryRun === true && archive.last.preview.length > 0
        ? (
          <>
            <span className={css.hint}>{t('subs.archive.recent.preview')}</span>
            <div className={css.rows} data-scope="archive-preview">
              {archive.last.preview.map(row => <SessionRow key={row.id} row={row} now={now} preview t={t} />)}
            </div>
          </>
        )
        : null}
      {archive === null
        ? null
        : (
          <>
            <span className={css.hint}>{t('subs.archive.recent.title')}</span>
            <div className={css.rows} data-scope="archive-recent">
              {archive.recent.length === 0 ? <div className={css.empty}>{t('subs.archive.recent.empty')}</div> : null}
              {archive.recent.map(row => <SessionRow key={row.id} row={row} now={now} preview={false} t={t} />)}
            </div>
          </>
        )}
      {renderFactorySlot?.('settings.plugin-config', { entries: ARCHIVE_CONFIG_ENTRIES, exclude: ARCHIVE_CONFIG_EXCLUDE })}
    </div>
  )
}
