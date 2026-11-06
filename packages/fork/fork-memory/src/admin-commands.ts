/**
 * The `memory-admin` commands. Each takes the parsed run and returns the process exit code; a thrown error is the
 * caller's to print. `ids` prints ids, categories, and counts without text; `recent` and `show` print entry text,
 * because the owner runs this tool over SSH (or has Claude Code run it) to find the entry a notice meant.
 */

import { rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CLI_ORIGIN, reviewWrite, type ReviewOp } from './admin.ts'
import { readAll, type ImportCliIo } from './cli-io.ts'
import { defaultFeedbackFile, FEEDBACK_SCOPES, FeedbackStore, type FeedbackScope } from './feedback.ts'
import type { MemoryStore } from './store.ts'

export const ADMIN_USAGE = [
  'usage: memory-admin <command> [--file <memory.jsonl>]',
  '  ids                             id, category, source of every entry and every waiting write (no text)',
  '  recent [--limit <n>]            newest changes first (waiting writes on top) with the opening of the text: find the id a notice meant',
  '  show <id>                       one entry in full, with its history',
  '  feedback add                    record the owner\'s keep/delete verdict on a persona reply: one JSON object on stdin',
  '                                  {"scope":"up|bili","verdict":"keep|delete","kind":"comment|dm","text":"<reply>","ref":"<stable id>","note":"<optional>"}',
  '  feedback list [--scope up|bili] verdicts, newest first',
  '  feedback forget <id>            remove one verdict',
  '  notices mute|unmute|status      silence the memory, reminder, and integrity notices to WeChat for 30 minutes (for tests)',
  '  approve <id>...                 keep waiting writes',
  '  discard <id>...                 drop waiting writes',
  '  revert <id>...                  undo the latest change of entries (a waiting write is dropped)',
  '  rollback --session <id> [--dry-run]   undo what a Session\'s turns changed',
  '  rollback --since <ISO time> [--dry-run]   undo what changed since a time',
  '  forget --purge <id>...          erase entries and every trace in the history, snapshots, and waiting writes',
].join('\n')

/** How long the mute file silences the safety notices (the channel applies the same window). */
const MUTE_MS = 30 * 60_000

/** Characters of an entry text `memory-admin recent` shows. */
const RECENT_TEXT_CHARS = 60

const oneLine = (text: string, chars: number): string => {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}



/** The parsed command line of one run. */
export interface AdminRun {
  readonly store: MemoryStore
  readonly io: ImportCliIo
  /** The words after the command. */
  readonly ids: readonly string[]
  readonly file: string | undefined
  readonly session: string | undefined
  readonly since: string | undefined
  readonly scope: string | undefined
  readonly limit: number
  readonly dryRun: boolean
  readonly purge: boolean
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

/** A command prints through the run's streams and returns the exit code. */
export type AdminCommand = (run: AdminRun) => Promise<number>

const usage = (run: AdminRun): number => {
  run.err(ADMIN_USAGE)
  return 2
}

async function listIds({ store, out }: AdminRun): Promise<number> {
  const index = await store.index()
  for (const entry of index.entries) out(`${entry.id} ${entry.category} ${entry.source}`)
  for (const entry of index.pending) out(`${entry.id} ${entry.category} pending-${entry.op}`)
  out(`memory-admin: ${String(index.entries.length)} entries, ${String(index.pending.length)} waiting`)
  return 0
}

async function notices(run: AdminRun): Promise<number> {
  const { io, ids, out } = run
  const muteFile = join(resolveDshHome(undefined, io.env ?? process.env), 'notices.muted')
  const [action] = ids
  if (action === 'mute') {
    await writeFile(muteFile, '', { mode: 0o600 })
    const now = new Date()
    await utimes(muteFile, now, now)
    out('memory-admin: safety notices muted for 30 minutes (run `notices mute` again to extend, `notices unmute` to end)')
    return 0
  }
  if (action === 'unmute') {
    await rm(muteFile, { force: true })
    out('memory-admin: safety notices are on')
    return 0
  }
  if (action === 'status') {
    const left = await stat(muteFile).then(info => Math.ceil((MUTE_MS - (Date.now() - info.mtimeMs)) / 60_000), () => 0)
    out(left > 0 ? `memory-admin: safety notices are muted, ${String(left)} minutes left` : 'memory-admin: safety notices are on')
    return 0
  }
  return usage(run)
}

async function feedbackAdd(feedback: FeedbackStore, { io, out, err }: AdminRun): Promise<number> {
  let payload: unknown
  try {
    payload = JSON.parse(await readAll(io.stdin ?? process.stdin))
  } catch {
    err('memory-admin: feedback add needs one JSON object on stdin')
    return 1
  }
  if (typeof payload !== 'object' || payload === null) {
    err('memory-admin: feedback add needs one JSON object on stdin')
    return 1
  }
  const result = await feedback.add(payload as Record<string, unknown> as never)
  out(`memory-admin: feedback ${result.entry.id} ${result.entry.scope} ${result.entry.verdict} ${result.outcome}`)
  return 0
}

async function feedbackList(feedback: FeedbackStore, run: AdminRun): Promise<number> {
  const { scope, out } = run
  if (scope !== undefined && !(FEEDBACK_SCOPES as readonly string[]).includes(scope)) return usage(run)
  for (const entry of await feedback.list(scope as FeedbackScope | undefined)) {
    out(`${entry.id} ${entry.scope} ${entry.verdict} ${entry.kind} ${entry.at} ${oneLine(entry.text, RECENT_TEXT_CHARS)}`)
  }
  return 0
}

async function feedbackCommand(run: AdminRun): Promise<number> {
  const { io, ids, file, out } = run
  const [action, id] = ids
  const feedback = new FeedbackStore(file === undefined ? defaultFeedbackFile(io.env) : join(dirname(file), 'feedback.jsonl'))
  if (action === 'add') return feedbackAdd(feedback, run)
  if (action === 'list') return feedbackList(feedback, run)
  if (action === 'forget' && id !== undefined) {
    await feedback.forget(id)
    out(`memory-admin: feedback ${id} forgotten`)
    return 0
  }
  return usage(run)
}

async function recent({ store, limit, out }: AdminRun): Promise<number> {
  const lines = (await store.listPending()).toReversed().map(entry => `waiting ${entry.op} ${entry.id} ${entry.category} ${entry.source ?? 'legacy'} ${entry.date} ${oneLine(entry.text, RECENT_TEXT_CHARS)}`)
  for (const record of (await store.history()).toReversed()) {
    const entry = record.after ?? record.before
    lines.push(`${record.at} ${record.op} ${record.id} ${entry?.category ?? '-'} ${record.source ?? 'legacy'} ${record.origin ?? '-'} ${oneLine(entry?.text ?? '', RECENT_TEXT_CHARS)}`)
  }
  for (const line of lines.slice(0, limit)) out(line)
  return 0
}

async function show(run: AdminRun): Promise<number> {
  const { store, ids, out, err } = run
  const [id] = ids
  if (id === undefined) return usage(run)
  const entry = (await store.list()).find(candidate => candidate.id === id)
  const waiting = (await store.listPending()).find(candidate => candidate.id === id)
  const found = entry ?? waiting
  if (found === undefined) { err(`memory-admin: no entry or waiting write under id ${id}`); return 1 }
  out(`${found.id} ${found.category} ${found.source ?? 'legacy'} ${found.date}${waiting !== undefined && entry === undefined ? ' (waiting)' : ''}`)
  out(found.text)
  for (const record of (await store.history()).filter(candidate => candidate.id === id)) out(`${record.at} ${record.op} ${record.source ?? 'legacy'} ${record.origin ?? '-'} session ${record.session ?? '-'}`)
  return 0
}

const review = (op: ReviewOp): AdminCommand => async (run) => {
  const { store, ids, out } = run
  if (ids.length === 0) return usage(run)
  for (const id of ids) {
    await reviewWrite(store, op, id, CLI_ORIGIN)
    out(`memory-admin: ${op} ${id} done`)
  }
  return 0
}

async function rollback(run: AdminRun): Promise<number> {
  const { store, session, since, dryRun, out } = run
  if (session === undefined && since === undefined) return usage(run)
  const filter = { ...session === undefined ? {} : { session }, ...since === undefined ? {} : { since } }
  const result = await store.rollback(filter, { dryRun })
  out(`memory-admin: rollback${dryRun ? ' (dry run)' : ''}: ${String(result.matched)} change(s) matched, ${String(result.restored)} restored, ${String(result.removed)} removed; ids ${result.ids.join(' ') || '-'}`)
  return 0
}

async function forget(run: AdminRun): Promise<number> {
  const { store, ids, purge, out } = run
  if (!purge || ids.length === 0) return usage(run)
  for (const id of ids) {
    const result = await store.purge(id)
    out(`memory-admin: purged ${id}: ${String(result.entries)} entry, ${String(result.history)} history, ${String(result.snapshots)} snapshot, ${String(result.pending)} waiting`)
  }
  return 0
}

/** Every command by name. */
export const ADMIN_COMMANDS: ReadonlyMap<string, AdminCommand> = new Map<string, AdminCommand>([
  ['ids', listIds],
  ['notices', notices],
  ['feedback', feedbackCommand],
  ['recent', recent],
  ['show', show],
  ['approve', review('approve')],
  ['discard', review('discard')],
  ['revert', review('revert')],
  ['rollback', rollback],
  ['forget', forget],
])
