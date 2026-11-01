/** Pure helpers of the Subscriptions section: form parsing and validation, request keys, and optimistic patches. */

import type { NewSubscription, SubscriptionAction, SubscriptionsView } from '../views.ts'

/** What the create form holds while it is edited. */
export interface SubscriptionDraft {
  id: string
  sources: string
  kinds: string
  subjects: string
  mode: 'notify' | 'session'
  instructions: string
  coalesceSeconds: string
  maxPerHour: string
}

/** A blank form. */
export function blankDraft(): SubscriptionDraft {
  return { id: '', sources: '', kinds: '', subjects: '', mode: 'notify', instructions: '', coalesceSeconds: '', maxPerHour: '' }
}

/** The form fields that can carry an error, each with its copy key suffix under `subs.form.err.`. */
export type DraftError = 'id' | 'selector' | 'instructions' | 'number'

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/u
const MAX_INSTRUCTIONS = 4000

/** Split a selector field on spaces and commas. */
export function parseList(text: string): string[] {
  return text.split(/[\s,]+/u).filter(entry => entry !== '')
}

/**
 * The same rules the Host applies, so the form says what is wrong before anything is sent.
 * @param draft - the form.
 * @returns the problems found, in field order; empty when the form can be sent.
 */
export function validateDraft(draft: SubscriptionDraft): DraftError[] {
  const errors: DraftError[] = []
  if (!ID.test(draft.id)) errors.push('id')
  if (parseList(draft.sources).length + parseList(draft.kinds).length + parseList(draft.subjects).length === 0) errors.push('selector')
  const instructions = draft.instructions.trim()
  if (draft.mode === 'session' && (instructions === '' || instructions.length > MAX_INSTRUCTIONS)) errors.push('instructions')
  const whole = (text: string, min: number, max: number): boolean => text === '' || (/^\d+$/u.test(text) && Number(text) >= min && Number(text) <= max)
  if (!whole(draft.coalesceSeconds, 0, 86_400) || !whole(draft.maxPerHour, 1, 60)) errors.push('number')
  return errors
}

/**
 * The request a valid form sends.
 * @param draft - a form that passed {@link validateDraft}.
 * @returns the create request.
 */
export function toRequest(draft: SubscriptionDraft): SubscriptionAction {
  const subscription: NewSubscription = {
    id: draft.id,
    sources: parseList(draft.sources),
    kinds: parseList(draft.kinds),
    subjects: parseList(draft.subjects),
    mode: draft.mode,
    ...draft.mode === 'session' ? { instructions: draft.instructions.trim() } : {},
    ...draft.coalesceSeconds === '' ? {} : { coalesceSeconds: Number(draft.coalesceSeconds) },
    ...draft.maxPerHour === '' ? {} : { maxPerHour: Number(draft.maxPerHour) },
  }
  return { action: 'create', subscription }
}

/** The busy key of a request: what is acted on. */
export function requestKey(request: SubscriptionAction): string {
  return request.action === 'create' ? `create:${request.subscription.id}` : `${request.action}:${request.target}:${request.id}`
}

/**
 * The patch that shows a request's effect before the Host answers.
 * @param request - the action about to be sent.
 * @returns a patch, or undefined for an action whose effect only the Host knows (create).
 */
export function optimisticPatch(request: SubscriptionAction): ((view: SubscriptionsView) => SubscriptionsView) | undefined {
  if (request.action === 'create') return undefined
  const { action, target, id } = request
  return (view) => {
    if (target === 'subscription') {
      if (view.subscriptions === null) return view
      return {
        ...view,
        subscriptions: action === 'delete'
          ? view.subscriptions.filter(row => row.id !== id)
          : view.subscriptions.map(row => (row.id === id ? { ...row, paused: action === 'pause' } : row)),
      }
    }
    if (view.schedules === null) return view
    return {
      ...view,
      schedules: action === 'delete'
        ? view.schedules.filter(row => row.id !== id)
        : view.schedules.map(row => (row.id === id ? { ...row, status: action === 'pause' ? 'paused' : 'active' } : row)),
    }
  }
}
