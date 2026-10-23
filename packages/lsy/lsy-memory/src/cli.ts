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
