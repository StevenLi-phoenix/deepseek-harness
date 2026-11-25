/** One owner action of either section of this package, as its store shows it. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The part of a section's state an action changes. */
export interface ActionState<Busy> {
  /** The action in flight. */
  busy: Busy | null
  /** Why the last action failed. */
  error: string | null
}

/**
 * Run one owner action: busy at once with the last error cleared, then the action, its error's message when it fails,
 * and busy cleared either way.
 * @param store - the section's store.
 * @param busy - the action's name while it runs.
 * @param work - the action; it publishes its own answer.
 * @param start - further changes made together with setting busy.
 * @returns settlement once busy is cleared; the action's failure is shown, never thrown.
 */
export async function runAction<Busy, State extends ActionState<Busy>>(
  store: SnapshotStore<State>,
  busy: Busy,
  work: () => Promise<void>,
  start?: (draft: State) => void,
): Promise<void> {
  store.update((draft) => {
    const action: ActionState<Busy> = draft
    action.busy = busy
    action.error = null
    start?.(draft)
  })
  try {
    await work()
  } catch (error: unknown) {
    store.update((draft) => {
      const action: ActionState<Busy> = draft
      action.error = error instanceof Error ? error.message : String(error)
    })
  } finally {
    store.update((draft) => {
      const action: ActionState<Busy> = draft
      action.busy = null
    })
  }
}
