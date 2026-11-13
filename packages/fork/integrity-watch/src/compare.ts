/** Comparing the watched targets with the last scan, and the notice a change earns. */

import { readFile } from 'node:fs/promises'
import { lastHistorySha, sha256 } from './files.ts'
import { ABSENT, diffTasks, digestOf, scheduleState, type Target } from './scan.ts'

/** What the baseline file holds. */
export interface Baseline {
  at: string
  digests: Record<string, string>
  /** The definition digest of each scheduled task at the last scan, to count what a direct edit changed. */
  scheduleTasks?: Record<string, string>
}

/**
 * The scheduled tasks as the schedule service last wrote them. Every `schedule/changed` event follows a
 * durable write of the service, so the file as it stood then is legitimate; a file that differs from it
 * was edited behind the service's back.
 */
export interface TrustedSchedule {
  at: string
  digest: string
  tasks?: Record<string, string>
}

/** How many tasks a direct edit of the schedule file added, removed, and changed. */
export interface TaskCounts {
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/** One change between the baseline and now. */
export interface Change {
  readonly target: string
  readonly label: string
  readonly kind: 'changed' | 'added' | 'removed'
  /** For the schedule file: how many tasks differ (counts only), when the earlier state is known. */
  readonly counts?: TaskCounts
}

/**
 * Compare the targets with a baseline.
 * @param targets - what to watch.
 * @param baseline - digests from the last scan; absent on the first run.
 * @param memoryFile - the memory file, checked against its history.
 * @param trusted - the schedule file as the schedule service last wrote it; a schedule file equal to it is not a change.
 * @returns the new digests, the task digests of the schedule file, and the changes (none when there is no baseline).
 */
export async function scan(
  targets: readonly Target[], baseline: Baseline | undefined, memoryFile: string, trusted?: TrustedSchedule,
): Promise<{ digests: Record<string, string>; scheduleTasks?: Record<string, string>; changes: Change[] }> {
  const digests: Record<string, string> = {}
  const changes: Change[] = []
  let scheduleTasks: Record<string, string> | undefined
  const compare = (target: string, label: string, was: string | undefined, now: string): void => {
    digests[target] = now
    if (was === undefined || was === now) return
    changes.push({ target, label, kind: was === ABSENT ? 'added' : now === ABSENT ? 'removed' : 'changed' })
  }
  for (const target of targets) {
    if (target.kind !== 'schedule') {
      compare(target.name, target.label, baseline?.digests[target.name], await digestOf(target))
      continue
    }
    // The schedule changes all day through the schedule service; it is a change only when it is not what the service last wrote.
    const state = await scheduleState(target.path)
    scheduleTasks = state.tasks
    const was = baseline?.digests[target.name]
    digests[target.name] = state.digest
    if (was === undefined || was === state.digest || trusted?.digest === state.digest) continue
    const earlier = trusted?.tasks ?? baseline?.scheduleTasks
    changes.push({
      target: target.name, label: target.label, kind: was === ABSENT ? 'added' : state.digest === ABSENT ? 'removed' : 'changed',
      ...earlier !== undefined && state.tasks !== undefined ? { counts: diffTasks(earlier, state.tasks) } : {},
    })
  }
  // The memory file changes legitimately all day; it is a change only when it is not what the memory history last wrote.
  let memory = ABSENT
  try {
    memory = sha256(await readFile(memoryFile, 'utf8'))
  } catch {
    // Absent.
  }
  const expected = await lastHistorySha(memoryFile) ?? baseline?.digests['memory']
  digests['memory'] = memory
  if (expected !== undefined && expected !== memory && baseline !== undefined) changes.push({ target: 'memory', label: '记忆文件 memory.jsonl（不是经记忆工具改的）', kind: 'changed' })
  return { digests, ...scheduleTasks === undefined ? {} : { scheduleTasks }, changes }
}

/**
 * The notice for a set of changes.
 * @param changes - what differs from the baseline.
 * @returns a title, and a body when the notice needs one; it names what changed and never shows the content.
 */
export function integrityNotice(changes: readonly Change[]): { title: string; body?: string } {
  const verb = { changed: '被改动', added: '新出现', removed: '被删除' } as const
  const bypass = { changed: '直接改动', added: '直接新建', removed: '直接删除' } as const
  const countsOf = (change: Change): string | undefined => {
    const counts = change.counts
    return counts === undefined ? undefined : `新增 ${String(counts.added)} 条、删除 ${String(counts.removed)} 条、修改 ${String(counts.changed)} 条`
  }
  const line = (change: Change): string => {
    if (change.target !== 'schedule') return `· ${change.label}：${verb[change.kind]}`
    const counts = countsOf(change)
    return `· 定时任务文件被绕过 DSH ${bypass[change.kind]}${counts === undefined ? '' : `：${counts}`}`
  }
  const [only] = changes
  if (changes.length === 1 && only !== undefined) {
    if (only.target !== 'schedule') return { title: `${only.label} ${verb[only.kind]}了（不显示内容）` }
    const counts = countsOf(only)
    return { title: `定时任务文件被绕过 DSH ${bypass[only.kind]}了（不显示内容）`, ...counts === undefined ? {} : { body: counts } }
  }
  return {
    title: `有 ${String(changes.length)} 处受监控的文件被改动（不显示内容）`,
    body: [...changes.slice(0, 8).map(line), ...changes.length > 8 ? [`…另有 ${String(changes.length - 8)} 处`] : []].join('\n'),
  }
}
