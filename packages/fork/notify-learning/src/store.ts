/**
 * The learner's directory: `exchanges.json`, `rules.json`, `history.jsonl`, and `raw/` with the model's latest answers.
 * Every file is owner-only (600, directories 700) and replaced whole through a temporary file and a rename; every change
 * runs on one serialized chain, so the capture and a nightly pass never interleave.
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { BackgroundWork } from '@deepseek-ai/dsh-service-kit'
import type { z } from 'zod'
import {
  EMPTY_STATE, exchangesFileSchema, historySchema, stateFileSchema,
  type Exchange, type HistoryRecord, type LearnState, type Reply,
} from './records.ts'

/** A file the learner cannot read as its schema says. */
export class LearningFileError extends Error {
  override readonly name = 'LearningFileError'
}

/** Bounds of the open exchanges. */
export interface ExchangeLimits {
  /** Open exchanges kept; the oldest go first. */
  readonly maxExchanges: number
  /** Hours after a message during which the owner's turns count as reactions to it. */
  readonly windowHours: number
  /** Owner turns kept per exchange. */
  readonly maxReplies: number
}

const ID_BYTES = 4

/**
 * A fresh id with a one-letter prefix.
 * @param prefix - `x` for an exchange, `r` for a rule.
 * @param bytes - random bytes, two hex digits each.
 * @returns the id.
 */
export function freshId(prefix: 'x' | 'r', bytes = prefix === 'x' ? ID_BYTES : 3): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`
}

/**
 * Read one JSON file through its schema.
 * @param file - the file.
 * @param schema - its schema.
 * @param missing - the value of a file that does not exist yet.
 * @returns the parsed value.
 * @throws {LearningFileError} when the file is not valid JSON of the schema.
 */
async function readJson<T>(file: string, schema: z.ZodType<T>, missing: T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new LearningFileError(`${file} is not valid JSON; fix or delete it`, { cause: error })
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new LearningFileError(`${file} does not match its schema (${parsed.error.issues[0]?.message ?? 'invalid'}); fix or delete it`)
  return parsed.data
}

/** The learner's files. */
export class LearningStore {
  readonly #work: BackgroundWork

  /**
   * @param dir - the learner's directory, created owner-only on the first write.
   * @param onFailure - receives the failure of work passed to {@link track}.
   */
  constructor(readonly dir: string, onFailure: (error: unknown) => void) {
    this.#work = new BackgroundWork(onFailure)
  }

  /**
   * Keep work nothing awaits alive until {@link drain}; its failure goes to `onFailure`.
   * @param work - a capture write and what follows it.
   */
  track(work: Promise<void>): void {
    this.#work.track(work)
  }

  private get exchangesFile(): string { return join(this.dir, 'exchanges.json') }
  private get stateFile(): string { return join(this.dir, 'rules.json') }
  private get historyFile(): string { return join(this.dir, 'history.jsonl') }

  /**
   * The open exchanges, oldest first.
   * @returns them; empty before the first one.
   * @throws {LearningFileError} when the file is damaged.
   */
  async exchanges(): Promise<Exchange[]> {
    return (await readJson(this.exchangesFile, exchangesFileSchema, { version: 1, exchanges: [] })).exchanges
  }

  /**
   * The rules, the clues, and the pass bookkeeping.
   * @returns the state; {@link EMPTY_STATE} before the first pass.
   * @throws {LearningFileError} when the file is damaged.
   */
  async state(): Promise<LearnState> {
    return readJson(this.stateFile, stateFileSchema, EMPTY_STATE)
  }

  /**
   * Keep one proactive message for the owner's reaction; the oldest go beyond `maxExchanges`.
   * @param exchange - the message, without replies.
   * @param limits - the bounds.
   * @returns resolves once written.
   */
  addExchange(exchange: Exchange, limits: ExchangeLimits): Promise<void> {
    return this.serialize(async () => {
      const exchanges = [...await this.exchanges(), exchange]
      await this.writeExchanges(exchanges.slice(-limits.maxExchanges))
    })
  }

  /**
   * Attach the owner's turn to every exchange still open for it: sent no more than `windowHours` before, with fewer
   * than `maxReplies` turns so far.
   * @param reply - the owner's words and the agent's answer.
   * @param limits - the bounds.
   * @returns how many exchanges took it.
   */
  addReply(reply: Reply, limits: ExchangeLimits): Promise<number> {
    return this.serialize(async () => {
      const at = Date.parse(reply.at)
      const windowMs = limits.windowHours * 3_600_000
      let taken = 0
      const exchanges = (await this.exchanges()).map((exchange) => {
        const sent = Date.parse(exchange.at)
        if (sent > at || at - sent > windowMs || exchange.replies.length >= limits.maxReplies) return exchange
        taken += 1
        return { ...exchange, replies: [...exchange.replies, reply] }
      })
      if (taken > 0) await this.writeExchanges(exchanges)
      return taken
    })
  }

  /**
   * Run one change of the rules and the exchanges on the store's chain: `change` reads both and returns what to write.
   * @param change - receives the current state and exchanges; returns the next state, the exchanges to keep, and an
   *   optional history line, or undefined to write nothing.
   * @returns what `change` returned.
   */
  update<T extends { state: LearnState; exchanges?: Exchange[]; history?: HistoryRecord } | undefined>(
    change: (state: LearnState, exchanges: Exchange[]) => Promise<T> | T,
  ): Promise<T> {
    return this.serialize(async () => {
      const result = await change(await this.state(), await this.exchanges())
      if (result === undefined) return result
      if (result.history !== undefined) {
        const line = historySchema.parse(result.history)
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        await appendFile(this.historyFile, `${JSON.stringify(line)}\n`, { mode: 0o600 })
      }
      await writeFileAtomic(this.stateFile, `${JSON.stringify(stateFileSchema.parse(result.state), null, 1)}\n`, { mode: 0o600, dirMode: 0o700 })
      if (result.exchanges !== undefined) await this.writeExchanges(result.exchanges)
      return result
    })
  }

  /**
   * Keep a model answer before it is parsed; only the latest `keep` stay.
   * @param stamp - ISO time of the call, the file's name.
   * @param raw - the answer and its stream end.
   * @param keep - files kept.
   * @returns resolves once written and pruned.
   */
  async saveRaw(stamp: string, raw: unknown, keep: number): Promise<void> {
    const dir = join(this.dir, 'raw')
    await writeFileAtomic(join(dir, `${stamp.replaceAll(':', '-')}.json`), `${JSON.stringify(raw)}\n`, { mode: 0o600, dirMode: 0o700 })
    const files = (await readdir(dir)).filter(file => file.endsWith('.json')).toSorted()
    for (const file of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dir, file), { force: true })
  }

  /**
   * Wait for every tracked piece and queued write.
   * @returns resolves once all of it settled.
   */
  drain(): Promise<void> {
    return this.#work.drain()
  }

  /**
   * Run `work` on the chain and keep it alive until {@link drain}.
   * @param work - one change.
   * @returns its result.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.#work.hold(this.#work.serialize(work))
  }

  private async writeExchanges(exchanges: readonly Exchange[]): Promise<void> {
    await writeFileAtomic(this.exchangesFile, `${JSON.stringify(exchangesFileSchema.parse({ version: 1, exchanges }))}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}
