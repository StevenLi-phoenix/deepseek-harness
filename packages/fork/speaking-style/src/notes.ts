/**
 * What the agent writes about how people talk and who it is, in `<dir>/notes.json`: memes and jargon (term, a one-line
 * meaning, a verbatim example) and traits of a group's overall tone (嘴硬, 损人, 黏人; never a member's), each with its
 * source platform (`qq` or `bili`) and when it was first and last seen; and the persona card the agent writes for
 * itself, with every version kept. Writing the same term again refreshes it; memes nobody mentions for `expireDays`
 * expire. Items the owner deletes stay blocked by their term. Written whole through a temporary file.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { NoteSource } from './view.ts'

/**
 * Where a meme's meaning came from: the agent's note, HotWatch's summary, pages the main agent had read (`web`), a web
 * search the miner ran (`search`), or the miner's model draft (`llm`).
 */
export const MEANING_SOURCES = ['agent', 'hotwatch', 'web', 'search', 'llm'] as const
/** One of {@link MEANING_SOURCES}. */
export type MeaningSource = typeof MEANING_SOURCES[number]
/** Most related terms one meme links to. */
export const MAX_RELATED = 4

/** One meme or trait. */
export interface Note {
  readonly id: string
  readonly kind: 'meme' | 'trait'
  readonly term: string
  /** One-line meaning of a meme; absent for a trait. */
  readonly meaning?: string
  /** A line from the group or the comments, verbatim. */
  readonly example: string
  readonly source: NoteSource
  /** Terms of the same meme family (a meme and its successors), at most {@link MAX_RELATED}. */
  readonly related?: readonly string[]
  /** Where the meaning came from; absent for a trait and for notes written before this field. */
  readonly meaningSource?: MeaningSource
  /** Epoch milliseconds. */
  readonly firstSeen: number
  readonly lastSeen: number
}

/** One version of the persona card. */
export interface CardVersion {
  readonly version: number
  readonly card: string
  /** `agent`: written with `persona_update`. `owner`: edited, rolled back, or deleted on the Settings page (the new baseline). */
  readonly author: 'agent' | 'owner'
  readonly reason: string
  readonly at: number
}

interface NotesFile {
  notes: Note[]
  /** Normalized terms the owner deleted. */
  blocked: string[]
  /** Versions, oldest first; the last one is current (an empty card means none). */
  cards: CardVersion[]
}

/** Caps of the file. */
export interface NotesLimits {
  readonly maxMemes: number
  readonly maxTraits: number
  /** Memes not seen for this many days expire. */
  readonly expireDays: number
  /** Card versions kept. */
  readonly maxVersions: number
}

/**
 * The identity of a term: case, width, spaces, and punctuation do not matter.
 * @param text - the term.
 * @returns the key.
 */
export function termKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

const chains = new Map<string, Promise<unknown>>()

/** The notes file and its operations. */
export class NotesStore {
  /**
   * @param file - absolute path of `notes.json`.
   * @param limits - caps.
   * @param now - clock; injectable for tests.
   */
  constructor(readonly file: string, private readonly limits: NotesLimits, private readonly now: () => number = Date.now) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = (chains.get(this.file) ?? Promise.resolve()).then(work, work)
    chains.set(this.file, next.catch(() => undefined))
    return next
  }

  private async load(): Promise<NotesFile> {
    let parsed: Partial<NotesFile> = {}
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<NotesFile>
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const notes: Array<Partial<Note>> = Array.isArray(parsed.notes) ? parsed.notes : []
    const cards: Array<Partial<CardVersion>> = Array.isArray(parsed.cards) ? parsed.cards : []
    return {
      notes: notes.filter((note): note is Note => (note.kind === 'meme' || note.kind === 'trait') && typeof note.term === 'string'
        && typeof note.example === 'string' && (note.source === 'qq' || note.source === 'bili' || note.source === 'web') && typeof note.lastSeen === 'number'),
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked.filter(term => typeof term === 'string') : [],
      cards: cards.filter((card): card is CardVersion => typeof card.card === 'string' && typeof card.version === 'number'),
    }
  }

  private async save(state: NotesFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }

  /** Expired memes go; the rest are capped, newest first. */
  private prune(notes: readonly Note[]): Note[] {
    const oldest = this.now() - this.limits.expireDays * 86_400_000
    const sorted = notes.toSorted((a, b) => b.lastSeen - a.lastSeen)
    const memes = sorted.filter(note => note.kind === 'meme' && note.lastSeen >= oldest).slice(0, this.limits.maxMemes)
    const traits = sorted.filter(note => note.kind === 'trait').slice(0, this.limits.maxTraits)
    return [...memes, ...traits]
  }

  /**
   * The notes that have not expired.
   * @returns current memes and traits, most recently seen first.
   */
  async notes(): Promise<Note[]> {
    return this.prune((await this.load()).notes)
  }

  /**
   * The terms that never come back.
   * @returns the normalized terms the owner deleted.
   */
  async blocked(): Promise<Set<string>> {
    return new Set((await this.load()).blocked)
  }

  /**
   * Write a meme or a trait, or refresh it when its term is known.
   * @param input - kind, term, meaning (memes), the verbatim example, the source, related terms, and where the meaning came from.
   * @returns `added`, `refreshed`, or `blocked` when the owner deleted that term.
   */
  async note(input: {
    readonly kind: Note['kind']
    readonly term: string
    readonly meaning?: string
    readonly example: string
    readonly source: NoteSource
    readonly related?: readonly string[]
    readonly meaningSource?: MeaningSource
  }): Promise<'added' | 'refreshed' | 'blocked'> {
    return await this.serialized(async () => {
      const state = await this.load()
      const key = termKey(input.term)
      if (state.blocked.includes(key)) return 'blocked'
      const at = this.now()
      const earlier = state.notes.find(note => note.kind === input.kind && termKey(note.term) === key)
      const related = (input.related ?? earlier?.related ?? []).filter(term => termKey(term) !== key).slice(0, MAX_RELATED)
      /* v8 ignore next 2 -- a kind is never empty. */
      const note: Note = {
        id: `${input.kind[0] ?? 'n'}${createHash('sha256').update(`${input.kind}:${key}`).digest('hex').slice(0, 11)}`,
        kind: input.kind, term: input.term, ...input.meaning === undefined ? {} : { meaning: input.meaning },
        example: input.example, source: input.source,
        ...related.length === 0 ? {} : { related },
        ...input.meaningSource === undefined ? {} : { meaningSource: input.meaningSource },
        firstSeen: earlier?.firstSeen ?? at, lastSeen: at,
      }
      state.notes = this.prune([note, ...state.notes.filter(other => other.id !== note.id)])
      await this.save(state)
      return earlier === undefined ? 'added' : 'refreshed'
    })
  }

  /**
   * Mark memes as seen again (their term appeared in new text), so they do not expire.
   * @param keys - normalized terms ({@link termKey}).
   * @returns how many memes were refreshed.
   */
  async touch(keys: ReadonlySet<string>): Promise<number> {
    return await this.serialized(async () => {
      const state = await this.load()
      const at = this.now()
      let touched = 0
      state.notes = state.notes.map((note) => {
        if (note.kind !== 'meme' || !keys.has(termKey(note.term))) return note
        touched += 1
        return { ...note, lastSeen: at }
      })
      if (touched > 0) await this.save(state)
      return touched
    })
  }

  /**
   * Delete a note for good: its term is blocked.
   * @param id - the note's id.
   * @returns the note, or undefined when no note has that id.
   */
  async remove(id: string): Promise<Note | undefined> {
    return await this.serialized(async () => {
      const state = await this.load()
      const found = state.notes.find(note => note.id === id)
      if (found === undefined) return undefined
      state.notes = state.notes.filter(note => note.id !== id)
      state.blocked = [...new Set([...state.blocked, termKey(found.term)])]
      await this.save(state)
      return found
    })
  }

  /**
   * Block a term that is not a stored note (a HotWatch title the owner deleted from the index).
   * @param term - the term.
   */
  async block(term: string): Promise<void> {
    await this.serialized(async () => {
      const state = await this.load()
      state.blocked = [...new Set([...state.blocked, termKey(term)])]
      await this.save(state)
    })
  }

  /**
   * The persona card history.
   * @returns every kept card version, oldest first; the last is current.
   */
  async cards(): Promise<CardVersion[]> {
    return (await this.load()).cards
  }

  /**
   * Delete one version from the history (the owner purging old text); the current version cannot be deleted.
   * @param version - the version number.
   * @returns whether a past version was removed.
   */
  async dropVersion(version: number): Promise<boolean> {
    return await this.serialized(async () => {
      const state = await this.load()
      if (state.cards.at(-1)?.version === version || !state.cards.some(card => card.version === version)) return false
      state.cards = state.cards.filter(card => card.version !== version)
      await this.save(state)
      return true
    })
  }

  /**
   * Write a new card version.
   * @param input - the card (empty deletes it), who wrote it, and why.
   * @returns the stored version.
   */
  async setCard(input: { readonly card: string; readonly author: CardVersion['author']; readonly reason: string }): Promise<CardVersion> {
    return await this.serialized(async () => {
      const state = await this.load()
      const version: CardVersion = {
        version: (state.cards.at(-1)?.version ?? 0) + 1, card: input.card, author: input.author, reason: input.reason, at: this.now(),
      }
      state.cards = [...state.cards, version].slice(-this.limits.maxVersions)
      await this.save(state)
      return version
    })
  }
}
