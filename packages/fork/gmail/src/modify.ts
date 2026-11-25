/**
 * Label changes on threads: read state, inbox, star, trash, and the account's own labels.
 */

import type { ModifyAction } from './actions.ts'
import type { GmailApi } from './api.ts'
import { assertNever, GmailError, READ_ONLY_REFUSAL } from './errors.ts'
import type { AccountRecord } from './storage.ts'

/** Threads one modify call may change. */
const MAX_MODIFY_THREADS = 50

/**
 * Change labels on threads.
 * @param api - the account's API client.
 * @param row - the account; a read-only one is refused.
 * @param threadIds - threads to change, 1 to 50.
 * @param action - the change.
 * @param label - the label's name or id, for `label` and `unlabel`.
 * @param recordActivity - stores the activity line of a label change; trash and untrash store none.
 * @returns how many threads changed.
 * @throws GmailError `refused` on a read-only account, `invalid` for a bad thread count or a missing label name,
 * `not-found` for an unknown label.
 */
export async function modifyThreads(
  api: GmailApi, row: AccountRecord, threadIds: readonly string[], action: ModifyAction, label: string | undefined,
  recordActivity: (detail: string) => Promise<void>,
): Promise<{ readonly changed: number }> {
  if (row.policy === 'read-only') throw new GmailError('refused', READ_ONLY_REFUSAL)
  if (threadIds.length === 0 || threadIds.length > MAX_MODIFY_THREADS) throw new GmailError('invalid', `give between 1 and ${MAX_MODIFY_THREADS} thread ids`)
  let add: string[] = []
  let remove: string[] = []
  switch (action) {
    case 'read': remove = ['UNREAD']; break
    case 'unread': add = ['UNREAD']; break
    case 'archive': remove = ['INBOX']; break
    case 'inbox': add = ['INBOX']; break
    case 'star': add = ['STARRED']; break
    case 'unstar': remove = ['STARRED']; break
    case 'trash':
    case 'untrash':
      for (const id of threadIds) await api.trashThread(id, action === 'untrash')
      return { changed: threadIds.length }
    case 'label':
    case 'unlabel': {
      const wanted = (label ?? '').trim().toLowerCase()
      if (wanted === '') throw new GmailError('invalid', 'label and unlabel need the label name')
      const labels = await api.labels()
      const found = labels.find(entry => entry.name.toLowerCase() === wanted || entry.id.toLowerCase() === wanted)
      if (found === undefined) throw new GmailError('not-found', `no label "${label}"; the account has: ${labels.filter(entry => entry.type !== 'system').map(entry => entry.name).slice(0, 40).join(', ') || 'no labels of its own'}`)
      if (action === 'label') add = [found.id]
      else remove = [found.id]
      break
    }
    /* v8 ignore next 2 -- ModifyAction is a closed union; the default only makes a new action a compile error. */
    default:
      return assertNever(action)
  }
  for (const id of threadIds) await api.modifyThread(id, add, remove)
  await recordActivity(`${action}${label === undefined ? '' : ` ${label}`} on ${threadIds.length} thread(s)`)
  return { changed: threadIds.length }
}
