/**
 * The periodic scan: compare the watched targets with the baseline, tell the owner what changed (never its content) within
 * the gap and daily limits, and move the baseline forward. A change that waits stays out of the baseline, so the next
 * scan finds it again and the notice merges what piled up.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fork-event-bus'
import { integrityNotice, scan, type Baseline, type Change, type TrustedSchedule } from './compare.ts'
import { readJson, writeJson } from './files.ts'
import { ABSENT, type Target } from './scan.ts'
import { mountScheduleTrust, trustedOf } from './schedule-trust.ts'

/** What the scanner needs, resolved from the configuration. */
export interface ScannerSettings {
  readonly targets: readonly Target[]
  readonly memoryFile: string
  readonly baselineFile: string
  readonly trustedFile: string
  readonly intervalMs: number
  /** Whether the owner is told at all. */
  readonly notify: boolean
  readonly minGapMs: number
  readonly perDay: number
}

/** Rate limits of the owner's notices: a minimum gap and a count per day. */
export class NoticeGate {
  private lastNoticeAt = 0
  private sentToday = { day: '', count: 0 }

  constructor(private readonly minGapMs: number, private readonly perDay: number) {}

  /**
   * Whether a notice must wait.
   * @param now - epoch ms.
   * @returns why it waits, or undefined when it may go.
   */
  holdBack(now: number): 'daily limit' | 'minimum gap' | undefined {
    this.rollDay(now)
    if (this.sentToday.count >= this.perDay) return 'daily limit'
    return now - this.lastNoticeAt < this.minGapMs ? 'minimum gap' : undefined
  }

  /**
   * Count a notice that went out.
   * @param now - epoch ms of the send.
   */
  sent(now: number): void {
    this.rollDay(now)
    this.lastNoticeAt = now
    this.sentToday.count += 1
  }

  private rollDay(now: number): void {
    const day = new Date(now).toDateString()
    if (this.sentToday.day !== day) this.sentToday = { day, count: 0 }
  }
}

/** One scan's findings, and the trusted schedule state they were compared with. */
interface Observed {
  readonly found: Awaited<ReturnType<typeof scan>>
  readonly trusted: TrustedSchedule | undefined
}

/**
 * Start scanning: once now, then every interval.
 * @param ctx - the root context.
 * @param settings - what to watch and how to tell the owner.
 */
export function mountScanner(ctx: Context, settings: ScannerSettings): void {
  const { targets, memoryFile, baselineFile, trustedFile, notify } = settings
  const scheduleTarget = targets.find(target => target.kind === 'schedule')
  const trust = mountScheduleTrust(ctx, scheduleTarget, trustedFile)
  const gate = new NoticeGate(settings.minGapMs, settings.perDay)
  let scanning: Promise<void> = Promise.resolve()

  /** Scan, and look again (twice at most) when a schedule write lands while the file is read. */
  const observe = async (baseline: Baseline | undefined): Promise<Observed> => {
    for (let attempt = 0; ; attempt += 1) {
      await trust.settled()
      const version = trust.version()
      const trusted = await readJson<TrustedSchedule>(trustedFile)
      const found = await scan(targets, baseline, memoryFile, trusted)
      if (version === trust.version() || attempt >= 2) return { found, trusted }
    }
  }

  /** Tell the owner; false when the notice failed and the scan must try again. */
  const tell = async (changes: readonly Change[], now: number): Promise<boolean> => {
    const notifier = ctx.get('forkNotifier')
    if (!notify || notifier === undefined) return true
    const note = integrityNotice(changes)
    try {
      await notifier.send({ title: note.title, ...note.body === undefined ? {} : { body: note.body }, safety: true, origin: 'the integrity watch of your own host (a notice to the owner that a file steering the agent changed)' })
      gate.sent(now)
      ctx.logger.info('fork-integrity: told the owner about %d change(s)', changes.length)
      return true
    } catch (error: unknown) {
      ctx.logger.warn('fork-integrity: notice failed, will retry: %s', error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const runScan = async (): Promise<void> => {
    const baseline = await readJson<Baseline>(baselineFile)
    const { found, trusted } = await observe(baseline)
    const { digests, scheduleTasks, changes } = found
    const stored = (): Baseline => ({ at: new Date().toISOString(), digests, ...scheduleTasks === undefined ? {} : { scheduleTasks } })
    // A schedule state nobody has reported yet is accepted as the trusted one: the first baseline, or a scan that found nothing new.
    const seedTrusted = async (): Promise<void> => {
      if (scheduleTarget === undefined || trusted !== undefined) return
      /* v8 ignore next -- the scan sets a digest for every target. */
      await writeJson(trustedFile, trustedOf(digests[scheduleTarget.name] ?? ABSENT, scheduleTasks))
    }
    if (baseline === undefined) {
      await writeJson(baselineFile, stored())
      await seedTrusted()
      ctx.logger.info('fork-integrity: baseline of %d target(s) written', Object.keys(digests).length)
      return
    }
    if (changes.length === 0) {
      const moved = JSON.stringify(digests) !== JSON.stringify(baseline.digests)
        || JSON.stringify(scheduleTasks) !== JSON.stringify(baseline.scheduleTasks)
      if (moved) await writeJson(baselineFile, stored())
      await seedTrusted()
      return
    }
    ctx.logger.warn('fork-integrity: %d target(s) changed: %s', changes.length, changes.map(change => `${change.target} (${change.kind})`).join(', '))
    const now = Date.now()
    const held = gate.holdBack(now)
    if (notify && held !== undefined) {
      ctx.logger.info('fork-integrity: notice held back (%s)', held)
      return
    }
    if (!await tell(changes, now)) return
    await writeJson(baselineFile, stored())
  }

  const schedule = (): void => {
    scanning = scanning.then(runScan).catch((error: unknown) => {
      /* v8 ignore next -- only fs errors reach here, which are Error instances. */
      ctx.logger.warn('fork-integrity: scan failed: %s', error instanceof Error ? error.message : String(error))
    })
  }
  schedule()
  const timer = setInterval(schedule, settings.intervalMs)
  timer.unref()
  // A scan under way still writes the baseline: teardown waits for it, so nothing lands in a directory being removed.
  ctx.effect(() => async () => { clearInterval(timer); await scanning }, 'fork-integrity: stop scanning')
}
