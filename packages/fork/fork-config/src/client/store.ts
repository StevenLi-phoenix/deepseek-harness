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
  /** Read the forms of some entries; rejects on a transport failure. */
  read(ids: readonly string[]): Promise<ConfigDescribe>
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

/** @returns a store holding no entry. */
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

  private patch(id: string, change: Partial<EntryState>): void {
    this.store.update((draft) => {
      const entries = draft.entries as Record<string, EntryState>
      entries[id] = { ...entries[id] ?? FRESH, ...change }
    })
  }

  private state(id: string): EntryState {
    return this.store.getSnapshot().entries[id] ?? FRESH
  }

  /**
   * Read some entries. A failed read keeps what the form shows and marks an entry that never loaded unreachable.
   * @param ids - the entry ids.
   * @returns settlement after the answer is published.
   */
  async load(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const phase = this.state(id).phase
      if (phase === 'unreachable') this.patch(id, { phase: 'loading' })
      else if (this.store.getSnapshot().entries[id] === undefined) this.patch(id, {})
    }
    let described: ConfigDescribe
    try {
      described = await this.transport.read(ids)
    } catch (error) {
      console.warn(`[fork-config] read of ${ids.join(',')} failed: ${error instanceof Error ? error.message : String(error)}`)
      for (const id of ids) {
        const current = this.state(id)
        if (current.phase === 'loading') this.patch(id, { phase: 'unreachable' })
      }
      return
    }
    for (const view of described.entries) {
      const current = this.state(view.id)
      // A save in flight owns the phase; its own settling publishes the view.
      this.patch(view.id, current.phase === 'saving' || current.phase === 'reloading' ? {} : { view, phase: 'ready' })
    }
  }

  /**
   * Save the staged edits of one entry and wait for the plugin to come back.
   * @param id - the entry.
   * @param revision - the revision the edits were staged against.
   * @param ops - the edits.
   * @returns whether the edits are in force and the plugin answers again.
   */
  async save(id: string, revision: string, ops: readonly ConfigOp[]): Promise<boolean> {
    const started = this.now()
    const paths = ops.map(op => pathLabel(op.path)).join(',')
    this.patch(id, { phase: 'saving', refused: null })
    let result: ConfigSaveResult | undefined
    try {
      result = await this.transport.write({ id, revision, ops })
    } catch (error) {
      console.warn(`[fork-config] save of ${id} [${paths}] got no answer: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result === undefined) {
      // The answer was lost, usually because the Host restarted its routes while reloading; the revision tells whether it landed.
      this.patch(id, { phase: 'reloading' })
      const landed = await this.awaitReload(id, revision, 'moved')
      if (!landed) this.patch(id, { phase: 'ready', refused: { reason: 'failed', message: '' } })
      console.info(`[fork-config] save of ${id} [${paths}] outcome=${landed ? 'unconfirmed-landed' : 'unknown'} in ${this.now() - started}ms`)
      return landed
    }
    if (!result.ok) {
      this.patch(id, { phase: 'ready', refused: { reason: result.reason, message: result.message } })
      console.warn(`[fork-config] save of ${id} [${paths}] outcome=${result.reason} in ${this.now() - started}ms`)
      if (result.reason === 'conflict' || result.reason === 'home-locked') await this.load([id])
      return false
    }
    if (result.changed.length === 0) {
      this.patch(id, { phase: 'ready' })
      await this.load([id])
      return true
    }
    this.patch(id, { phase: 'reloading' })
    const answered = await this.awaitReload(id, result.revision, 'equals')
    console.info(`[fork-config] save of ${id} [${result.changed.join(',')}] outcome=${answered ? 'ok' : 'reload-timeout'} in ${this.now() - started}ms`)
    return answered
  }

  /** Ask until the plugin answers with the wanted revision: `equals` that of the save, or `moved` away from the staged one. */
  private async awaitReload(id: string, revision: string, wanted: 'equals' | 'moved'): Promise<boolean> {
    for (let attempt = 0; attempt < this.policy.attempts; attempt++) {
      await this.sleep(this.policy.intervalMs)
      let view: ConfigEntryView | undefined
      try {
        view = (await this.transport.read([id])).entries.find(entry => entry.id === id)
      } catch (_notBackYet) {
        // The route is unreachable while the Host reloads; ask again.
        continue
      }
      if (view?.active !== true) continue
      if (wanted === 'equals' ? view.revision === revision : view.revision !== revision) {
        this.patch(id, { view, phase: 'ready', savedAt: this.now() })
        return true
      }
    }
    this.patch(id, { phase: 'unreachable' })
    return false
  }
}
