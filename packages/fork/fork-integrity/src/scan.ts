/**
 * Digests of the files that steer the agent. A digest says whether something changed, never what:
 * the notice names the target, and the content stays where it is.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** What a target is. */
export type TargetKind = 'file' | 'dir' | 'schedule'

/** One thing to watch. */
export interface Target {
  /** Stable name used in the baseline and the notice. */
  readonly name: string
  /** What the owner calls it, shown in the notice. */
  readonly label: string
  readonly kind: TargetKind
  readonly path: string
}

/** Digest of a target that does not exist. */
export const ABSENT = 'absent'

/** Most files one directory digest reads. */
const MAX_FILES = 2000
/** Largest file whose content is hashed; a bigger one is hashed by size and mtime. */
const MAX_BYTES = 4 * 1024 * 1024
/** Directory names a digest skips. */
const SKIP = new Set(['node_modules', '.git', '.DS_Store'])

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

async function fileDigest(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > MAX_BYTES) return sha(`big:${String(info.size)}:${String(info.mtimeMs)}`)
  return sha(await readFile(path))
}

async function dirDigest(root: string): Promise<string> {
  const rows: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_FILES) return
      if (SKIP.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() || entry.isSymbolicLink()) rows.push(`${relative(root, path)}\0${await fileDigest(path).catch(() => 'unreadable')}`)
    }
  }
  await walk(root)
  return sha(rows.join('\n'))
}

/** The scheduled tasks by id and definition; delivery history changes on every run and is left out. */
async function scheduleDigest(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { tables?: { tasks?: Record<string, { record?: unknown }> } }
  const tasks = parsed.tables?.tasks ?? {}
  return sha(Object.keys(tasks).toSorted().map(id => `${id}\0${sha(JSON.stringify(tasks[id]?.record ?? null))}`).join('\n'))
}

/**
 * Digest one target.
 * @param target - what to read.
 * @returns a hex digest, {@link ABSENT} when the target does not exist, or `unreadable` when it cannot be read.
 */
export async function digestOf(target: Target): Promise<string> {
  try {
    switch (target.kind) {
      case 'file': return await fileDigest(target.path)
      case 'dir': return await dirDigest(target.path)
      case 'schedule': return await scheduleDigest(target.path)
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ABSENT
    return 'unreadable'
  }
}

/** The instruction files a workspace may carry. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'] as const

/**
 * The targets of one deployment.
 * @param home - `DSH_HOME`.
 * @param workspaces - directories the agent works in.
 * @param userHome - the service user's home, for `~/.agents/skills`.
 */
export function targetsFor(home: string, workspaces: readonly string[], userHome: string): Target[] {
  const targets: Target[] = [
    { name: 'home-patch', label: '家目录层 cordis.patch.yml', kind: 'file', path: join(home, 'cordis.patch.yml') },
    { name: 'owner-patch', label: 'owner 层 cordis.patch.yml', kind: 'file', path: join(home, 'profiles', 'event', 'cordis.patch.yml') },
    { name: 'home-skills', label: '技能目录 (DSH_HOME/skills)', kind: 'dir', path: join(home, 'skills') },
    { name: 'user-skills', label: '技能目录 (~/.agents/skills)', kind: 'dir', path: join(userHome, '.agents', 'skills') },
    { name: 'schedule', label: '定时任务（定义）', kind: 'schedule', path: join(home, 'storages', 'schedule.json') },
    ...INSTRUCTION_FILES.map(file => ({ name: `home-${file}`, label: `DSH_HOME/${file}`, kind: 'file' as const, path: join(home, file) })),
  ]
  for (const workspace of workspaces) {
    for (const file of INSTRUCTION_FILES) targets.push({ name: `${workspace}/${file}`, label: `${workspace}/${file}`, kind: 'file', path: join(workspace, file) })
    for (const sub of ['.dsh/skills', '.agents/skills']) targets.push({ name: `${workspace}/${sub}`, label: `${workspace}/${sub}`, kind: 'dir', path: join(workspace, sub) })
  }
  return targets
}
