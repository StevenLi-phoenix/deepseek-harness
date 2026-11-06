/**
 * The configuration store and its loader: what the Host last said about each entry, and the one save at a time per
 * entry. A save that landed makes the plugin reload, so the loader keeps asking until the new instance answers with
 * the revision the save produced; the form says "reloading" until then and never shows a half-applied state.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  pathLabel,
  type ConfigDescribe, type ConfigEntryView, type ConfigOp, type ConfigSaveFailure, type ConfigSaveRequest, type ConfigSaveResult,
} from '../view.ts'

/** Where one entry stands. */
export type EntryPhase = 'loading' | 'ready' | 'saving' | 'reloading' | 'unreachable'

/**
 * The key an entry is stored under: its id, and the fields a dedicated editor owns, because the Host's description
 * (and its revision) leaves those out.
 * @param id - the plugin entry id.
 * @param exclude - dotted paths left out of the form.
 * @returns the store key.
 */
export function entryKey(id: string, exclude: readonly string[] = []): string {
  return exclude.length === 0 ? id : `${id}\u0000${exclude.join(',')}`
}

/** What the form renders for one entry. */
export interface EntryState {
  /** The last description the Host gave; kept while a read fails or the plugin reloads. */
  readonly view: ConfigEntryView | null
  readonly phase: EntryPhase
  /** Why the last save did not land; cleared by the next save. */
  readonly refused: { readonly reason: ConfigSaveFailure; readonly message: string } | null
  /** When the last save landed and the plugin answered again. */
  readonly savedAt: number | null
}

/** All entries the card shows. */
export interface ConfigState {
  readonly entries: Readonly<Record<string, EntryState>>
}

/** How the loader reaches the Host. */
export interface ConfigTransport {
  /** Read the forms of some entries, leaving out the `exclude` fields; rejects on a transport failure. */
  read(ids: readonly string[], exclude: readonly string[]): Promise<ConfigDescribe>
  /** Send a save; rejects when the answer is lost, which leaves its outcome unknown. */
  write(request: ConfigSaveRequest): Promise<ConfigSaveResult>
}

/** Waits for a reload. */
export interface ReloadPolicy {
  /** How many times the loader asks whether the plugin answers again. */
  readonly attempts: number
  /** Pause before each ask, in milliseconds. */
  readonly intervalMs: number
}

/** The reload wait used in the browser: about thirty seconds. */
export const RELOAD_POLICY: ReloadPolicy = { attempts: 40, intervalMs: 750 }

const FRESH: EntryState = { view: null, phase: 'loading', refused: null, savedAt: null }

/**
 * Create the store the card reads.
 * @returns a store holding no entry.
 */
export function createConfigStore(): SnapshotStore<ConfigState> {
  return createSnapshotStore<ConfigState>({ entries: {} })
}

/** Reads and saves entries into a store. */
export class ConfigLoader {
  /**
   * @param store - the store the card renders.
   * @param transport - the Host routes.
   * @param policy - how long a reload is waited for.
   * @param sleep - pause, replaceable in tests.
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: SnapshotStore<ConfigState>,
    private readonly transport: ConfigTransport,
    private readonly policy: ReloadPolicy = RELOAD_POLICY,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  private patch(key: string, change: Partial<EntryState>): void {
    this.store.update((draft) => {
      const entries = draft.entries as Record<string, EntryState>
      entries[key] = { ...entries[key] ?? FRESH, ...change }
    })
  }

  private state(key: string): EntryState {
    return this.store.getSnapshot().entries[key] ?? FRESH
  }

  /**
   * Read some entries. A failed read keeps what the form shows and marks an entry that never loaded unreachable.
   * @param ids - the entry ids.
   * @param exclude - dotted paths of fields a dedicated editor owns, left out of the form and its revision.
   * @returns settlement after the answer is published.
   */
  async load(ids: readonly string[], exclude: readonly string[] = []): Promise<void> {
    for (const id of ids) {
      const key = entryKey(id, exclude)
      if (this.state(key).phase === 'unreachable') this.patch(key, { phase: 'loading' })
      else if (this.store.getSnapshot().entries[key] === undefined) this.patch(key, {})
    }
    let described: ConfigDescribe
    try {
      described = await this.transport.read(ids, exclude)
    } catch (error) {
      console.warn(`[lsy-config] read of ${ids.join(',')} failed: ${error instanceof Error ? error.message : String(error)}`)
      for (const id of ids) {
        const key = entryKey(id, exclude)
        if (this.state(key).phase === 'loading') this.patch(key, { phase: 'unreachable' })
      }
      return
    }
    for (const view of described.entries) {
      const key = entryKey(view.id, exclude)
      const { phase } = this.state(key)
      // A save in flight owns the phase; its own settling publishes the view.
      this.patch(key, phase === 'saving' || phase === 'reloading' ? {} : { view, phase: 'ready' })
    }
  }

  /**
   * Save the staged edits of one entry and, when the plugin reloads, wait for it to come back.
   * @param id - the entry.
   * @param exclude - dotted paths the form left out; the save neither writes them nor is fenced by them.
   * @param revision - the revision the edits were staged against.
   * @param ops - the edits.
   * @returns whether the edits are in force and the plugin answers again.
   */
  async save(id: string, exclude: readonly string[], revision: string, ops: readonly ConfigOp[]): Promise<boolean> {
    const started = this.now()
    const key = entryKey(id, exclude)
    const paths = ops.map(op => pathLabel(op.path)).join(',')
    this.patch(key, { phase: 'saving', refused: null })
    let result: ConfigSaveResult | undefined
    try {
      result = await this.transport.write({ id, revision, ops, ...exclude.length === 0 ? {} : { exclude } })
    } catch (error) {
      console.warn(`[lsy-config] save of ${id} [${paths}] got no answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result === undefined) {
      // The answer was lost, usually because the Host restarted its routes while reloading; the revision tells whether it landed.
      this.patch(key, { phase: 'reloading' })
      const landed = await this.awaitReload(id, exclude, revision, 'moved')
      if (!landed) this.patch(key, { phase: 'ready', refused: { reason: 'failed', message: '' } })
      console.info(`[lsy-config] save of ${id} [${paths}] outcome=${landed ? 'unconfirmed-landed' : 'unknown'} in ${this.now() - started}ms`)
      return landed
    }
    if (!result.ok) {
      this.patch(key, { phase: 'ready', refused: { reason: result.reason, message: result.message } })
      console.warn(`[lsy-config] save of ${id} [${paths}] outcome=${result.reason} in ${this.now() - started}ms`)
      if (result.reason === 'conflict' || result.reason === 'home-locked') await this.load([id], exclude)
      return false
    }
    if (!result.reload) {
      // Nothing was changed, or only volatile fields: the running plugin took them without reloading.
      this.patch(key, { phase: 'ready', savedAt: result.changed.length === 0 ? null : this.now() })
      await this.load([id], exclude)
      console.info(`[lsy-config] save of ${id} [${result.changed.join(',')}] outcome=ok reload=false in ${this.now() - started}ms`)
      return true
    }
    this.patch(key, { phase: 'reloading' })
    const answered = await this.awaitReload(id, exclude, result.revision, 'equals')
    console.info(`[lsy-config] save of ${id} [${result.changed.join(',')}] outcome=${answered ? 'ok' : 'reload-timeout'} in ${this.now() - started}ms`)
    return answered
  }

  /** Ask until the plugin answers with the wanted revision: `equals` that of the save, or `moved` away from the staged one. */
  private async awaitReload(id: string, exclude: readonly string[], revision: string, wanted: 'equals' | 'moved'): Promise<boolean> {
    const key = entryKey(id, exclude)
    for (let attempt = 0; attempt < this.policy.attempts; attempt++) {
      await this.sleep(this.policy.intervalMs)
      let view: ConfigEntryView | undefined
      try {
        view = (await this.transport.read([id], exclude)).entries.find(entry => entry.id === id)
      } catch (_notBackYet) {
        // The route is unreachable while the Host reloads; ask again.
        continue
      }
      if (view?.active !== true) continue
      if (wanted === 'equals' ? view.revision === revision : view.revision !== revision) {
        this.patch(key, { view, phase: 'ready', savedAt: this.now() })
        return true
      }
    }
    this.patch(key, { phase: 'unreachable' })
    return false
  }
}
