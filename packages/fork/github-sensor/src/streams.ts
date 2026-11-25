/**
 * The repository streams the sensor polls and the cursor key of each.
 */

/** Per-repository streams. */
export type RepoStream = 'releases' | 'commits' | 'tags'

/** Every repository stream, in documentation order. */
export const REPO_STREAMS: readonly RepoStream[] = ['releases', 'tags', 'commits']

/**
 * Cursor key of one repository stream; a commits stream on an explicit branch keeps its own cursor.
 * @param watch - repository and branch.
 * @param kind - stream.
 * @returns `repo:<owner/name>:<kind>` or `repo:<owner/name>:commits@<branch>`.
 */
export function streamId(watch: { readonly repo: string; readonly branch?: string }, kind: RepoStream): string {
  const branch = kind === 'commits' && watch.branch !== undefined ? `@${watch.branch}` : ''
  return `repo:${watch.repo}:${kind}${branch}`
}
