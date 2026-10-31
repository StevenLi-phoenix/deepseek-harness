/**
 * `memory-import`: load a claude.ai memory export into the memory file. Run it as
 * the service user so the file belongs to that user; it prints counts, never entry text.
 */

import { readFile } from 'node:fs/promises'
import { parseClaudeExport } from './export.ts'
import { CATEGORIES } from './entries.ts'
import { defaultMemoryFile, MemoryStore } from './store.ts'

const USAGE = 'usage: memory-import [--dry-run] [--file <memory.jsonl>] [<export.md>]   (reads the export from stdin without a path)'

/** Streams and environment of one run; defaults to the process's. */
export interface ImportCliIo {
  readonly argv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: AsyncIterable<string | Buffer>
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

async function readAll(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Run the import.
 * @param io - arguments, environment, and streams.
 * @returns the process exit code.
 */
export async function runImportCli(io: ImportCliIo = {}): Promise<number> {
  const argv = io.argv ?? process.argv.slice(2)
  const out = io.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const err = io.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  let dryRun = false
  let file: string | undefined
  let source: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--file' && argv[index + 1] !== undefined) file = argv[++index]
    else if (arg !== undefined && !arg.startsWith('-') && source === undefined) source = arg
    else {
      err(USAGE)
      return 2
    }
  }
  const store = new MemoryStore(file ?? defaultMemoryFile(io.env))
  try {
    const text = source === undefined ? await readAll(io.stdin ?? process.stdin) : await readFile(source, 'utf8')
    const drafts = parseClaudeExport(text)
    if (drafts.length === 0) {
      err('memory-import: no entries found; expected "## <n>. <Category>" headings over "[YYYY-MM-DD] - text" lines')
      return 1
    }
    const counts = CATEGORIES.map(category => `${category} ${String(drafts.filter(draft => draft.category === category).length)}`).join(', ')
    out(`memory-import: ${String(drafts.length)} entries in the export (${counts})`)
    if (dryRun) return 0
    const result = await store.importDrafts(drafts)
    out(`memory-import: added ${String(result.added)}, already present ${String(result.duplicates)}; ${store.file} holds ${String((await store.list()).length)}`)
    return 0
  } catch (error: unknown) {
    err(`memory-import: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const ADMIN_USAGE = [
  'usage: memory-admin <command> [--file <memory.jsonl>]',
  '  ids                             id, category, source of every entry and every waiting write (no text)',
  '  recent [--limit <n>]            newest changes first (waiting writes on top) with the opening of the text: find the id a notice meant',
  '  show <id>                       one entry in full, with its history',
  '  approve <id>...                 keep waiting writes',
  '  discard <id>...                 drop waiting writes',
  '  revert <id>...                  undo the latest change of entries (a waiting write is dropped)',
  '  rollback --session <id> [--dry-run]   undo what a Session\'s turns changed',
  '  rollback --since <ISO time> [--dry-run]   undo what changed since a time',
  '  forget --purge <id>...          erase entries and every trace in the history, snapshots, and waiting writes',
].join('\n')

/** Characters of an entry text `memory-admin recent` shows. */
const RECENT_TEXT_CHARS = 60

const oneLine = (text: string, chars: number): string => {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`
}

/**
 * Run the admin tool: review and undo memory changes. `ids` prints ids, categories, and counts without text;
 * `recent` and `show` print entry text, because the owner runs this tool over SSH (or has Claude Code run it) to
 * find the entry a notice meant.
 * @param io - arguments, environment, and streams.
 * @returns the process exit code.
 */
export async function runAdminCli(io: ImportCliIo = {}): Promise<number> {
  const argv = [...io.argv ?? process.argv.slice(2)]
  const out = io.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const err = io.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  let file: string | undefined
  let session: string | undefined
  let since: string | undefined
  let dryRun = false
  let purge = false
  let limit = 10
  const words: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file' && argv[index + 1] !== undefined) file = argv[++index]
    else if (arg === '--session' && argv[index + 1] !== undefined) session = argv[++index]
    else if (arg === '--since' && argv[index + 1] !== undefined) since = argv[++index]
    else if (arg === '--limit' && /^\d+$/u.test(argv[index + 1] ?? '')) limit = Number(argv[++index])
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--purge') purge = true
    else if (arg !== undefined && !arg.startsWith('-')) words.push(arg)
    else {
      err(ADMIN_USAGE)
      return 2
    }
  }
  const [command, ...ids] = words
  const store = new MemoryStore(file ?? defaultMemoryFile(io.env))
  try {
    switch (command) {
      case 'ids': {
        const index = await store.index()
        for (const entry of index.entries) out(`${entry.id} ${entry.category} ${entry.source}`)
        for (const entry of index.pending) out(`${entry.id} ${entry.category} pending-${entry.op}`)
        out(`memory-admin: ${String(index.entries.length)} entries, ${String(index.pending.length)} waiting`)
        return 0
      }
      case 'recent': {
        const lines = (await store.listPending()).toReversed().map(entry => `waiting ${entry.op} ${entry.id} ${entry.category} ${entry.source ?? 'legacy'} ${entry.date} ${oneLine(entry.text, RECENT_TEXT_CHARS)}`)
        for (const record of (await store.history()).toReversed()) {
          const entry = record.after ?? record.before
          lines.push(`${record.at} ${record.op} ${record.id} ${entry?.category ?? '-'} ${record.source ?? 'legacy'} ${record.origin ?? '-'} ${oneLine(entry?.text ?? '', RECENT_TEXT_CHARS)}`)
        }
        for (const line of lines.slice(0, limit)) out(line)
        return 0
      }
      case 'show': {
        const [id] = ids
        if (id === undefined) { err(ADMIN_USAGE); return 2 }
        const entry = (await store.list()).find(candidate => candidate.id === id)
        const waiting = (await store.listPending()).find(candidate => candidate.id === id)
        const found = entry ?? waiting
        if (found === undefined) { err(`memory-admin: no entry or waiting write under id ${id}`); return 1 }
        out(`${found.id} ${found.category} ${found.source ?? 'legacy'} ${found.date}${waiting !== undefined && entry === undefined ? ' (waiting)' : ''}`)
        out(found.text)
        for (const record of (await store.history()).filter(candidate => candidate.id === id)) out(`${record.at} ${record.op} ${record.source ?? 'legacy'} ${record.origin ?? '-'} session ${record.session ?? '-'}`)
        return 0
      }
      case 'approve':
      case 'discard':
      case 'revert': {
        if (ids.length === 0) { err(ADMIN_USAGE); return 2 }
        for (const id of ids) {
          if (command === 'approve') await store.approve(id)
          else if (command === 'discard') await store.discard(id)
          else await store.revert(id)
          out(`memory-admin: ${command} ${id} done`)
        }
        return 0
      }
      case 'rollback': {
        if (session === undefined && since === undefined) { err(ADMIN_USAGE); return 2 }
        const filter = { ...session === undefined ? {} : { session }, ...since === undefined ? {} : { since } }
        const result = await store.rollback(filter, { dryRun })
        out(`memory-admin: rollback${dryRun ? ' (dry run)' : ''}: ${String(result.matched)} change(s) matched, ${String(result.restored)} restored, ${String(result.removed)} removed; ids ${result.ids.join(' ') || '-'}`)
        return 0
      }
      case 'forget': {
        if (!purge || ids.length === 0) { err(ADMIN_USAGE); return 2 }
        for (const id of ids) {
          const result = await store.purge(id)
          out(`memory-admin: purged ${id}: ${String(result.entries)} entry, ${String(result.history)} history, ${String(result.snapshots)} snapshot, ${String(result.pending)} waiting`)
        }
        return 0
      }
      default:
        err(ADMIN_USAGE)
        return 2
    }
  } catch (error: unknown) {
    err(`memory-admin: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
