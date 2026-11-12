/**
 * The daily share: once a local day, at a random time inside the owner's window, the account's
 * Session is prompted to message the owner first: a video worth watching (its subtitles read) and a
 * recent 热梗. It is the one message the account starts, and it goes only to the owner's main account
 * through bili-svc's `POST /v1/share/owner` (owner mids, its own daily cap, rules, canaries, brake).
 * The plan is stored before it is due, so a restart never shares twice; a share waits while the owner
 * sleeps, is messaging the account, or has messages queued, and is `missed` two hours after the window.
 * The owner turns it off in Settings or sends one at once (现在发一条).
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { biliDomain, type ShareRecord } from './storage.ts'
import { codePoints, sharePrompt, type ShareMemory } from './text.ts'
import { dayKey, formatStamp, localTime, parseClock } from './time.ts'
import type { ShareOutcome, ShareRow, ShareView } from './view.ts'

/** Configuration of the daily share. */
export interface ShareConfig {
  /** Whether it runs; the owner's switch in Settings wins. */
  enabled: boolean
  /** Window of the day's random time, `HH:MM` in the account's `timeZone`. */
  start: string
  end: string
}

/** A share still waiting this long after the window ends is `missed`. */
export const SHARE_GRACE_MS = 2 * 3_600_000
/** A share whose turn has not ended this long after its prompt is `failed` (the turn was lost, e.g. by a restart). */
export const SHARE_TURN_MS = 45 * 60_000
/** Shares kept in storage, newest first; older rows are deleted. */
export const SHARE_KEPT = 30
/** Earlier shares the prompt lists so the account does not repeat itself. */
export const SHARE_REMEMBERED = 7
/** Code points of a sent share kept for Settings and the next prompts. */
export const SHARE_TEXT_CHARS = 300
/** Settings lists this many shares. */
const SHARE_LISTED = 10

/** What the share needs of the account. */
export interface ShareHost {
  readonly ready: Promise<Domain<typeof biliDomain>>
  /** Storage work, one piece at a time. */
  serialize<T>(work: () => Promise<T>): Promise<T>
  /** The owner's main account, or undefined while unset (nothing is shared). */
  ownerMid(): number | undefined
  /** Why the owner should not be messaged right now (asleep, messaging the account, messages waiting), or undefined. */
  holdReason(now: number): string | undefined
  /**
   * Prompt the account's Session with the share; the DM channel sends the turn's answer as the share.
   * @returns the Session id, or undefined when the Session is in a turn.
   */
  prompt(text: string): Promise<string | undefined>
  readonly timeZone: string
  now(): number
  /** A number in [0, 1). */
  random(): number
  logger: { info(message: string): void; warn(message: string): void }
}

/** Fail at load on a window that cannot work. */
export function assertShareConfig(config: ShareConfig): void {
  const start = parseClock(config.start)
  const end = parseClock(config.end)
  if (start === undefined || end === undefined) throw new Error(`bili: share.start and share.end must be HH:MM (got "${config.start}" and "${config.end}")`)
  if (end <= start) throw new Error(`bili: share.end (${config.end}) must be after share.start (${config.start}) on the same day`)
}

/** The row Settings shows. */
function rowView(row: ShareRecord): ShareRow {
  return {
    day: row.day, reason: row.reason, planAt: row.planAt, firedAt: row.firedAt ?? null,
    outcome: row.outcome ?? null, detail: row.detail ?? null, text: row.text ?? null,
  }
}

/** Keep at most `max` code points. */
function bounded(text: string, max: number): string {
  const points = Array.from(text.trim())
  return points.length <= max ? points.join('') : `${points.slice(0, max - 1).join('')}…`
}

/** The daily share's schedule and bookkeeping. */
export class DailyShare {
  /** The share whose turn runs now, by storage key and Session. */
  private running: { key: string; sessionId: string } | undefined
  /** Hold reasons already logged per key, so a wait is logged once, not every minute. */
  private readonly logged = new Map<string, string>()

  /**
   * @param host - storage, the owner account, prompting, time, and the logger.
   * @param config - window and default switch; checked by {@link assertShareConfig}.
   */
  constructor(private readonly host: ShareHost, private readonly config: ShareConfig) {
    assertShareConfig(config)
  }

  /** Whether the share runs: the owner's switch, else the configuration. */
  async enabled(): Promise<boolean> {
    const domain = await this.host.ready
    return domain.table('share_prefs').get('main')?.enabled ?? this.config.enabled
  }

  /**
   * The owner's switch in Settings.
   * @param enabled - whether the daily share runs.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      await domain.table('share_prefs').put('main', { enabled, updatedAt: this.host.now() })
    })
    this.host.logger.info(`bili: the owner turned the daily share ${enabled ? 'on' : 'off'}`)
  }

  /** The window of the local day containing `now`, as instants. */
  private window(now: number): { day: string; start: number; end: number } {
    const day = dayKey(now, this.host.timeZone)
    /* v8 ignore next 2 -- assertShareConfig checked both clocks at load. */
    const start = localTime(day, parseClock(this.config.start) ?? 0, this.host.timeZone)
    const end = localTime(day, parseClock(this.config.end) ?? 0, this.host.timeZone)
    return { day, start, end }
  }

  /** Run once a minute: plan today's share, settle a lost turn, and prompt the Session when the share is due. */
  async tick(): Promise<void> {
    const now = this.host.now()
    await this.settleLost(now)
    if (!await this.enabled() || this.host.ownerMid() === undefined) return
    const { day, start, end } = this.window(now)
    const domain = await this.host.ready
    let row = domain.table('share_days').get(day)
    if (row === undefined) row = await this.plan(day, start, end, now)
    if (row.outcome !== undefined || row.firedAt !== undefined) return
    if (now < row.planAt || now > end + SHARE_GRACE_MS) return
    await this.fire(day, row, now)
  }

  /** Store today's plan: a random time in what is left of the window, or `missed` when the window is over. */
  private async plan(day: string, start: number, end: number, now: number): Promise<ShareRecord> {
    const from = Math.max(start, now + 60_000)
    const record: ShareRecord = from >= end
      ? { day, reason: 'plan', planAt: end, outcome: 'missed', detail: `planned at ${formatStamp(now, this.host.timeZone)}, after the window ${this.config.start}–${this.config.end}`, settledAt: now }
      : { day, reason: 'plan', planAt: Math.floor(from + this.host.random() * (end - from)) }
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      await domain.table('share_days').put(day, record)
      await this.prune(domain)
    })
    this.host.logger.info(record.outcome === 'missed'
      ? `bili: today's share (${day}) is missed: ${record.detail}`
      : `bili: today's share (${day}) is planned at ${formatStamp(record.planAt, this.host.timeZone)} (window ${this.config.start}–${this.config.end} ${this.host.timeZone})`)
    return record
  }

  /** Prompt the Session unless something holds the share; a hold is logged once per reason. */
  private async fire(key: string, row: ShareRecord, now: number): Promise<string> {
    if (this.running !== undefined) return 'another share is running'
    const hold = this.host.holdReason(now)
    if (hold !== undefined) {
      if (this.logged.get(key) !== hold) this.host.logger.info(`bili: the share ${key} waits: ${hold}`)
      this.logged.set(key, hold)
      return hold
    }
    const domain = await this.host.ready
    const recent = this.memory(domain, key)
    const text = sharePrompt({ now, timeZone: this.host.timeZone, manual: row.reason === 'manual', recent })
    let sessionId: string | undefined
    try {
      sessionId = await this.host.prompt(text)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.host.logger.warn(`bili: prompting the Session for the share ${key} failed: ${detail}`)
      return `the Session could not be prompted: ${detail}`
    }
    if (sessionId === undefined) {
      if (this.logged.get(key) !== 'busy') this.host.logger.info(`bili: the share ${key} waits: the Session is in a turn`)
      this.logged.set(key, 'busy')
      return 'the Session is in a turn'
    }
    this.running = { key, sessionId }
    this.logged.delete(key)
    await this.host.serialize(async () => {
      await domain.table('share_days').put(key, { ...row, firedAt: now, sessionId })
    })
    this.host.logger.info(`bili: the share ${key} prompted Session ${sessionId} (${text.length} chars, ${recent.length} earlier share(s) listed)`)
    return 'started'
  }

  /** The latest sent shares before `key`, for the prompt. */
  private memory(domain: Domain<typeof biliDomain>, key: string): ShareMemory[] {
    return [...domain.table('share_days').entries()]
      .filter(([other, row]) => other !== key && row.text !== undefined && (row.outcome === 'sent' || row.outcome === 'wechat'))
      .map(([, row]) => row)
      .sort((a, b) => (b.firedAt ?? b.planAt) - (a.firedAt ?? a.planAt))
      .slice(0, SHARE_REMEMBERED)
      .map(row => ({ day: row.day, text: row.text ?? '' }))
  }

  /**
   * The owner pressed 现在发一条: one share at once, outside the plan and its window (bili-svc's daily cap still applies).
   * @returns `started`, or why it did not start.
   */
  async sendNow(): Promise<string> {
    if (this.host.ownerMid() === undefined) return 'no owner account is set'
    if (this.running !== undefined) return 'a share is running'
    const now = this.host.now()
    const day = dayKey(now, this.host.timeZone)
    const key = `${day}~m${now}`
    const row: ShareRecord = { day, reason: 'manual', planAt: now }
    // The owner asked: only a running turn or a missing owner stops it, not sleep or a quiet hour.
    let sessionId: string | undefined
    try {
      const recent = this.memory(await this.host.ready, key)
      sessionId = await this.host.prompt(sharePrompt({ now, timeZone: this.host.timeZone, manual: true, recent }))
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      this.host.logger.warn(`bili: prompting the Session for a manual share failed: ${detail}`)
      return `the Session could not be prompted: ${detail}`
    }
    if (sessionId === undefined) return 'the Session is in a turn'
    this.running = { key, sessionId }
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      await domain.table('share_days').put(key, { ...row, firedAt: now, sessionId })
      await this.prune(domain)
    })
    this.host.logger.info(`bili: the owner asked for a share now; prompted Session ${sessionId}`)
    return 'started'
  }

  /**
   * Whether the Session's running turn is a share's: the DM channel then sends its answer as the share.
   * @param sessionId - the account's Session.
   */
  isShareTurn(sessionId: string): boolean {
    return this.running?.sessionId === sessionId
  }

  /**
   * The DM channel settled the running share's turn.
   * @param sessionId - the account's Session.
   * @param outcome - how it went.
   * @param detail - why, in one line.
   * @param text - what reached the owner, when something did.
   */
  async settled(sessionId: string, outcome: ShareOutcome, detail: string, text?: string): Promise<void> {
    const running = this.running
    if (running?.sessionId !== sessionId) return
    this.running = undefined
    await this.settle(running.key, outcome, detail, text)
  }

  /** Record a share's outcome. */
  private async settle(key: string, outcome: ShareOutcome, detail: string, text?: string): Promise<void> {
    await this.host.serialize(async () => {
      const domain = await this.host.ready
      const row = domain.table('share_days').get(key)
      if (row === undefined) return
      await domain.table('share_days').put(key, {
        ...row, outcome, detail, settledAt: this.host.now(),
        ...(text === undefined || text.trim() === '' ? {} : { text: bounded(text, SHARE_TEXT_CHARS) }),
      })
    })
    this.logged.delete(key)
    const chars = text === undefined ? '' : `, ${codePoints(text.trim())} chars`
    const line = `bili: the share ${key} ended ${outcome}${chars}: ${detail}`
    if (outcome === 'failed' || outcome === 'wechat') this.host.logger.warn(line)
    else this.host.logger.info(line)
  }

  /**
   * Settle what can no longer happen: a share prompted long ago whose turn never ended (the turn was
   * lost) is `failed`; a planned share of an earlier day still waiting past its grace is `missed`.
   */
  private async settleLost(now: number): Promise<void> {
    const domain = await this.host.ready
    for (const [key, row] of [...domain.table('share_days').entries()]) {
      if (row.outcome !== undefined) continue
      if (row.firedAt !== undefined) {
        if (now - row.firedAt < SHARE_TURN_MS) continue
        if (this.running?.key === key) this.running = undefined
        await this.settle(key, 'failed', `its turn did not end within ${SHARE_TURN_MS / 60_000} min (DSH restarted, or the turn hung)`)
        continue
      }
      /* v8 ignore next -- assertShareConfig checked the clock at load. */
      const deadline = localTime(row.day, parseClock(this.config.end) ?? 0, this.host.timeZone) + SHARE_GRACE_MS
      if (now <= deadline) continue
      const waited = this.logged.get(key)
      await this.settle(key, 'missed', `it could not run before ${formatStamp(deadline, this.host.timeZone)}${waited === undefined ? '' : ` (${waited})`}`)
    }
  }

  /** Delete all but the newest {@link SHARE_KEPT} rows. */
  private async prune(domain: Domain<typeof biliDomain>): Promise<void> {
    const rows = [...domain.table('share_days').entries()].sort(([, a], [, b]) => b.planAt - a.planAt)
    for (const [key] of rows.slice(SHARE_KEPT)) await domain.table('share_days').delete(key)
  }

  /** What Settings shows. */
  async view(): Promise<ShareView> {
    const domain = await this.host.ready
    const now = this.host.now()
    const today = domain.table('share_days').get(dayKey(now, this.host.timeZone))
    const recent = [...domain.table('share_days').entries()].map(([, row]) => row).sort((a, b) => (b.firedAt ?? b.planAt) - (a.firedAt ?? a.planAt)).slice(0, SHARE_LISTED)
    return {
      enabled: await this.enabled(),
      overridden: domain.table('share_prefs').get('main') !== undefined,
      start: this.config.start,
      end: this.config.end,
      today: today === undefined ? null : rowView(today),
      recent: recent.map(rowView),
      running: this.running !== undefined,
    }
  }
}
