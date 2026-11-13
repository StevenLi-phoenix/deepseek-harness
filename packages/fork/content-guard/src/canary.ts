/**
 * The canary layer: strings that must never appear in text that leaves the owner's private side. A file the owner keeps
 * (one string per line, `#` comments) and strings from the configuration (honeypot tokens). A match is a refusal
 * whatever the surrounding text; the strings themselves are never logged or returned.
 */

import { readFile, stat } from 'node:fs/promises'
import { squash } from './fold.ts'

/**
 * Shortest canary compared, in code points; shorter ones would match unrelated text. Two suffice when a CJK character
 * is in it (a two-character name).
 */
const MIN_LATIN = 3
const MIN_CJK = 2
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** What loading the canaries found, as counts. */
export interface CanaryCounts {
  /** Canaries in use. */
  readonly active: number
  /** Lines or configured strings left out for being too short. */
  readonly tooShort: number
  /** Whether the file exists. */
  readonly fileFound: boolean
}

/**
 * Parse canary lines.
 * @param lines - raw strings.
 * @returns the squashed canaries and the number left out for being too short.
 */
export function parseCanaries(lines: Iterable<string>): { canaries: string[]; tooShort: number } {
  const canaries = new Set<string>()
  let tooShort = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const folded = squash(line)
    if (Array.from(folded).length < (HAS_CJK.test(folded) ? MIN_CJK : MIN_LATIN)) {
      tooShort += 1
      continue
    }
    canaries.add(folded)
  }
  return { canaries: [...canaries], tooShort }
}

/** The canary strings, reloaded when the file changes. */
export class CanarySet {
  private fromFile: string[] = []
  private fileShort = 0
  private readonly fromConfig: string[]
  private readonly configShort: number
  private stamp = ''
  private fileFound = false

  /**
   * @param file - absolute path of the canary file; a missing file is an empty list.
   * @param extra - strings from the configuration.
   */
  constructor(readonly file: string, extra: readonly string[]) {
    const parsed = parseCanaries(extra)
    this.fromConfig = parsed.canaries
    this.configShort = parsed.tooShort
  }

  /**
   * Counts of what is loaded, after refreshing from the file.
   * @returns active and too-short canary counts, and whether the file was found.
   * @throws when the file exists and cannot be read.
   */
  async counts(): Promise<CanaryCounts> {
    await this.refresh()
    return { active: this.fromFile.length + this.fromConfig.length, tooShort: this.fileShort + this.configShort, fileFound: this.fileFound }
  }

  /**
   * Whether the text contains a canary, compared without case, width, spacing, or punctuation.
   * @param text - the text to check.
   * @returns true when any loaded canary appears in the text.
   * @throws when the file exists and cannot be read; a caller that publishes must treat that as a refusal.
   */
  async matches(text: string): Promise<boolean> {
    await this.refresh()
    const squashed = squash(text)
    if (squashed === '') return false
    return [...this.fromConfig, ...this.fromFile].some(canary => squashed.includes(canary))
  }

  private async refresh(): Promise<void> {
    let stamp: string
    try {
      const info = await stat(this.file)
      stamp = `${String(info.mtimeMs)}:${String(info.size)}`
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.fromFile = []
      this.fileShort = 0
      this.fileFound = false
      this.stamp = ''
      return
    }
    if (stamp === this.stamp) return
    const parsed = parseCanaries((await readFile(this.file, 'utf8')).split(/\r?\n/u))
    this.fromFile = parsed.canaries
    this.fileShort = parsed.tooShort
    this.fileFound = true
    this.stamp = stamp
  }
}
