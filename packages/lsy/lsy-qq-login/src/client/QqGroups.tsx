/**
 * The whitelist card: the groups lsy-qq records, the account's other groups to add with one tap, and a field for a
 * number. Writes go through the plugin-settings form of the `lsy-qq` entry (revision-fenced, saved to the profile
 * patch, applied live), never to a file; the card reads the list back from the same form.
 */

import { useId, useState, type ReactNode } from 'react'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { QqGroup } from '../view.ts'
import type { Translate } from './cards.ts'
import { CANDIDATES_SHOWN, candidateRows, parseGroupId, whitelistRows, type GroupRow, type GroupsSection } from './groups.ts'
import css from './QqLogin.module.css'

/** What the card needs from the section. */
export interface QqGroupsProps {
  /** The settings form of the `lsy-qq` entry, as the shell last accepted it. */
  form: ConfigFormSnapshot<GroupsSection>
  /** The Host panel's groups (names, counts); empty before the first answer. */
  groups: readonly QqGroup[]
  translate: Translate
  /** Add a group to the list; resolves to whether the Host accepted the write. */
  addGroup: (id: string) => Promise<boolean>
  /** Remove a group from the list; resolves to whether the Host accepted the write. */
  removeGroup: (id: string) => Promise<boolean>
}

function Row({ row, translate, children }: { row: GroupRow; translate: Translate; children: ReactNode }): ReactNode {
  return (
    <li className={css.groupRow}>
      <span className={css.groupName}>
        <span className={css.groupTitle}>{row.name}</span>
        <span className={css.groupMeta}>
          {row.groupId}
          {row.memberCount === null ? '' : ` · ${translate('groups.members', { count: row.memberCount })}`}
          {row.seen > 0 ? ` · ${translate('groups.seen', { count: row.seen })}` : ''}
        </span>
      </span>
      {children}
    </li>
  )
}

/**
 * Render the whitelist card.
 * @param props - the form snapshot, the Host's groups, and the two writes.
 * @returns the card.
 */
export function QqGroupsCard({ form, groups, translate, addGroup, removeGroup }: QqGroupsProps): ReactNode {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const listed = form.value?.groups
  if (form.status === 'unavailable') {
    return (
      <section className={css.card} aria-labelledby={id}>
        <span id={id} className={css.cardTitle}>{translate('groups.title')}</span>
        <p className={css.hint}>{translate('groups.unavailable')}</p>
      </section>
    )
  }
  if (listed === undefined) return null
  const editable = form.writable && !busy

  const run = async (write: () => Promise<boolean>): Promise<void> => {
    setBusy(true)
    setRefused(false)
    try {
      setRefused(!await write())
    } catch {
      setRefused(true)
    } finally {
      setBusy(false)
    }
  }
  const rows = whitelistRows(listed, groups)
  const candidates = candidateRows(listed, groups)
  const shown = showAll ? candidates : candidates.slice(0, CANDIDATES_SHOWN)

  return (
    <section className={css.card} aria-labelledby={id}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{translate('groups.title')}</span>
        <span className={css.meta}>{translate('groups.count', { count: listed.length })}</span>
      </div>
      <p className={css.hint}>{translate('groups.hint')}</p>
      {form.writable ? null : <p className={css.notice}>{translate('groups.readonly')}</p>}
      {refused ? <p className={css.notice} role="alert">{translate('groups.refused')}</p> : null}
      {rows.length === 0
        ? <p className={css.next}>{translate('groups.empty')}</p>
        : (
          <ul className={css.groupList} aria-label={translate('groups.title')}>
            {rows.map(row => (
              <Row key={row.groupId} row={row} translate={translate}>
                {confirming === row.groupId
                  ? (
                    <span className={css.groupActions}>
                      <button type="button" className={css.danger} disabled={!editable} onClick={() => { setConfirming(null); void run(() => removeGroup(row.groupId)) }}>
                        {translate('groups.removeConfirm')}
                      </button>
                      <button type="button" className={css.secondary} onClick={() => { setConfirming(null) }}>{translate('groups.cancel')}</button>
                    </span>
                  )
                  : <button type="button" className={css.secondary} disabled={!editable} onClick={() => { setConfirming(row.groupId) }}>{translate('groups.remove')}</button>}
              </Row>
            ))}
          </ul>
        )}
      {candidates.length === 0
        ? null
        : (
          <>
            <span className={css.subTitle}>{translate('groups.candidates')}</span>
            <p className={css.hint}>{translate('groups.candidates.hint')}</p>
            <ul className={css.groupList} aria-label={translate('groups.candidates')}>
              {shown.map(row => (
                <Row key={row.groupId} row={row} translate={translate}>
                  <button type="button" className={css.secondary} disabled={!editable} onClick={() => { void run(() => addGroup(row.groupId)) }}>{translate('groups.add')}</button>
                </Row>
              ))}
            </ul>
            {showAll || candidates.length <= CANDIDATES_SHOWN
              ? null
              : <button type="button" className={css.link} onClick={() => { setShowAll(true) }}>{translate('groups.more', { count: candidates.length - CANDIDATES_SHOWN })}</button>}
          </>
        )}
      <form
        className={css.manual}
        onSubmit={(event) => {
          event.preventDefault()
          const parsed = parseGroupId(typed)
          setInvalid(parsed === null)
          if (parsed === null) return
          setTyped('')
          void run(() => addGroup(parsed))
        }}
      >
        <label className={css.manualLabel}>
          <span>{translate('groups.manual')}</span>
          <input
            className={css.input}
            inputMode="numeric"
            autoComplete="off"
            placeholder={translate('groups.manual.placeholder')}
            value={typed}
            onChange={(event) => { setTyped(event.target.value); setInvalid(false) }}
            aria-invalid={invalid}
          />
        </label>
        <button type="submit" className={css.secondary} disabled={!editable || typed.trim() === ''}>{translate('groups.add')}</button>
      </form>
      {invalid ? <p className={css.notice} role="alert">{translate('groups.manual.invalid')}</p> : null}
    </section>
  )
}
