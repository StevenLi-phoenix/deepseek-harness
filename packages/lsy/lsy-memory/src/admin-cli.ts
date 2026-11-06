/** `memory-admin`: review and undo memory changes. */

import { defaultMemoryFile, MemoryStore } from './store.ts'
import { ADMIN_COMMANDS, ADMIN_USAGE, type AdminRun } from './admin-commands.ts'
import { streams, type ImportCliIo } from './cli-io.ts'

/** The options and words of one command line, or `undefined` for a malformed one. */
type Parsed = Omit<AdminRun, 'store' | 'io' | 'out' | 'err'> & { readonly command: string | undefined }

/**
 * Split a command line into its options and the command with its words.
 * @param argv - the arguments after the program name.
 * @returns the parsed line, or `undefined` when an option is unknown or lacks its value.
 */
export function parseAdminArgs(argv: readonly string[]): Parsed | undefined {
  let file: string | undefined
  let session: string | undefined
  let since: string | undefined
  let dryRun = false
  let purge = false
  let limit = 10
  let scope: string | undefined
  const words: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file' && argv[index + 1] !== undefined) file = argv[++index]
    else if (arg === '--session' && argv[index + 1] !== undefined) session = argv[++index]
    else if (arg === '--since' && argv[index + 1] !== undefined) since = argv[++index]
    else if (arg === '--limit' && /^\d+$/u.test(argv[index + 1] ?? '')) limit = Number(argv[++index])
    else if (arg === '--scope' && argv[index + 1] !== undefined) scope = argv[++index]
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--purge') purge = true
    else if (arg !== undefined && !arg.startsWith('-')) words.push(arg)
    else return undefined
  }
  const [command, ...ids] = words
  return { command, ids, file, session, since, scope, limit, dryRun, purge }
}

/**
 * Run the admin tool: review and undo memory changes. `ids` prints ids, categories, and counts without text;
 * `recent` and `show` print entry text, because the owner runs this tool over SSH (or has Claude Code run it) to
 * find the entry a notice meant.
 * @param io - arguments, environment, and streams.
 * @returns the process exit code.
 */
export async function runAdminCli(io: ImportCliIo = {}): Promise<number> {
  const { out, err } = streams(io)
  const parsed = parseAdminArgs(io.argv ?? process.argv.slice(2))
  if (parsed === undefined) {
    err(ADMIN_USAGE)
    return 2
  }
  const { command, ...options } = parsed
  const store = new MemoryStore(options.file ?? defaultMemoryFile(io.env))
  try {
    const run = command === undefined ? undefined : ADMIN_COMMANDS.get(command)
    if (run === undefined) {
      err(ADMIN_USAGE)
      return 2
    }
    return await run({ ...options, store, io, out, err })
  } catch (error: unknown) {
    err(`memory-admin: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
