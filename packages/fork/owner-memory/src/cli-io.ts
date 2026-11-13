/** What the two CLIs share: their streams and environment, and reading stdin. */

/** Streams and environment of one run; defaults to the process's. */
export interface ImportCliIo {
  readonly argv?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: AsyncIterable<string | Buffer>
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
}

/**
 * Read a stream to the end as UTF-8 text.
 * @param stream - stdin or a test stand-in.
 * @returns everything it yielded.
 */
export async function readAll(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The output functions of a run: the injected ones, else the process's streams.
 * @param io - the run's streams.
 * @returns line writers for stdout and stderr.
 */
export function streams(io: ImportCliIo): { out: (line: string) => void; err: (line: string) => void } {
  return {
    out: io.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`) }),
    err: io.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`) }),
  }
}
