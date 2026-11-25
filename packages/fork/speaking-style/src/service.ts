/**
 * The speaking-style service the root row provides as `ctx.speakingStyle`: the tone samples, the notes, the persona
 * card, the meme miner, and the scheduled collection, kept under the plugin directory.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.credentials.
import type {} from '@deepseek-ai/dsh-credentials'
// Type-only: ctx.web, the miner's search.
import type {} from '@deepseek-ai/dsh-web'
// Type-only: ctx.ownerNotifier, for the card revision notice.
import type {} from '@deepseek-ai/dsh-event-bus'
// Type-only: ctx.qq, the QQ observer collection and notes read.
import type {} from '@deepseek-ai/dsh-qq'
import type {} from '@deepseek-ai/dsh-session'
// Type-only: the compaction events' SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import { createBiliReader } from './bili.ts'
import { optionalService, StyleGate } from './guard.ts'
import { gatherInputs, WebInbox, type HotSource } from './inputs.ts'
import { MemeMiner, type SearchCall } from './miner.ts'
import { createModelCall } from './model.ts'
import { recentPublicText, WEB_TOOLS } from './session-text.ts'
import { StyleCollector, type BiliReader, type CollectSettings, type QqSource } from './collect.ts'
import { normalizeLine, screenNote } from './filter.ts'
import { HotWatch, type HotMeme } from './hotwatch.ts'
import { MAX_RELATED, NotesStore, termKey } from './notes.ts'
import { renderStyleBlock } from './render.ts'
import { StyleError, StyleStore } from './store.ts'
import type { LookupAnswer, StyleNoteInput, WriteAnswer } from './tools.ts'
import { readTrend, ticTrend } from './trend.ts'
import type { MineReport, NoteSource, RunReport, StyleEditAnswer, StylePanel } from './view.ts'
import type { Config } from './index.ts'

/** Default bili-svc address; `BILI_SVC_URL` in the service environment overrides it. */
const DEFAULT_BILI_URL = 'http://127.0.0.1:8097'

/** A rendered block, its counts, and the card version it shows. */
export interface StyleBlock {
  readonly text: string
  /** Tone exchanges shown, and the owner's among them. */
  readonly shown: number
  readonly owner: number
  /** Names in the meme index. */
  readonly memes: number
  /** Card version, 0 without a card. */
  readonly card: number
}

/** What `ctx.speakingStyle.health()` answers: counts only, never text. */
export interface StyleHealth {
  /** Active tone samples. */
  readonly kept: number
  /** Tone samples waiting for the owner. */
  readonly pending: number
  readonly review: 'optional' | 'required'
  /** Epoch milliseconds of the last tone collection's start; null before the first. */
  readonly lastRefreshAt: number | null
  /** Share of answers with stock lines, the last days against the days before; null with fewer than two days of data. */
  readonly ticTrend: 'up' | 'flat' | 'down' | null
}

/** DSH's speaking style: what the root row provides as `ctx.speakingStyle`. */
export class StyleService {
  /** The rotation zone of the block. */
  readonly timeZone: string
  private readonly store: StyleStore
  private readonly notes: NotesStore
  private readonly collector: StyleCollector
  private readonly hotwatch: HotWatch | undefined
  private readonly gate: StyleGate
  private readonly inbox: WebInbox
  private readonly miner: MemeMiner
  private readonly abort = new AbortController()
  private latest: StyleHealth = { kept: 0, pending: 0, review: 'optional', lastRefreshAt: null, ticTrend: null }

  /**
   * @param ctx - the root context: logger, `ctx.qq`, `ctx.biliEvidence`, `ctx.credentials`, `ctx.ownerNotifier`, each read when needed.
   * @param config - resolved configuration.
   * @param paths - the data directory and integrity-watch's stock-line counts.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly paths: { readonly dir: string; readonly ticsFile: string },
  ) {
    this.timeZone = config.timeZone
    this.store = new StyleStore(join(paths.dir, 'samples.jsonl'), { maxActive: config.maxActive, maxOwner: config.maxOwner, maxPending: config.maxPending, maxTombstones: 3000 })
    this.notes = new NotesStore(join(paths.dir, 'notes.json'), {
      maxMemes: config.memes.maxStored, maxTraits: config.traits.max,
      expireDays: config.memes.expireDays, maxVersions: config.persona.maxVersions,
    })
    const settings: CollectSettings = {
      rules: { maxChars: config.maxChars, identityMarkers: config.identityMarkers, blocklist: config.blocklist },
      qq: {
        enabled: config.qq.enabled, windowHours: config.qq.windowHours, maxMessages: config.qq.maxMessages,
        gapMs: config.qq.gapSec * 1000, settleMs: config.qq.settleMinutes * 60_000,
      },
      bili: {
        enabled: config.bili.enabled, ownerAccount: config.bili.ownerAccount,
        comments: config.bili.comments, maxThreads: config.bili.maxThreads,
      },
      maxAgeMs: config.maxAgeDays * 86_400_000,
      perRun: config.perRun,
      perKey: config.perGroup,
      review: config.review,
    }
    const biliUrl = config.bili.url ?? process.env['BILI_SVC_URL'] ?? DEFAULT_BILI_URL
    this.collector = new StyleCollector({
      store: this.store, settings, logger: ctx.logger, stateFile: join(paths.dir, 'state.json'),
      qq: (): QqSource | undefined => ctx.get('qq'),
      bili: async (): Promise<BiliReader | 'no-token'> => {
        const credentials = ctx.get('credentials')
        const token = credentials === undefined ? undefined : (await credentials.resolve(credentialRef(config.bili.tokenEnv)))?.value
        if (token === undefined || token === '') return 'no-token'
        return createBiliReader({ baseUrl: biliUrl, token, timeoutMs: config.bili.timeoutMs, fetch: (...args) => fetch(...args) })
      },
    })
    this.hotwatch = config.hotwatch.enabled && config.memes.enabled
      ? new HotWatch({
        url: config.hotwatch.url, limit: config.hotwatch.limit, ttlMs: config.hotwatch.ttlMs, timeoutMs: config.hotwatch.timeoutMs,
        fetch: (...args) => fetch(...args), warn: (message) => { ctx.logger.warn(message) },
      })
      : undefined
    this.gate = new StyleGate(ctx, (message) => { ctx.logger.warn('%s', message) }, (message) => { ctx.logger.info('%s', message) })
    const { miner } = config
    this.inbox = new WebInbox(join(paths.dir, 'web-inbox.json'), miner.inbox)
    const search: SearchCall = async (query, signal) => {
      const web = ctx.get('web')
      if (web === undefined) return undefined
      const result = await web.search({ query, maxResults: 5 }, signal)
      const text = [result.content, ...result.sources.map(source => [source.title, source.summary ?? source.snippet].filter(part => part !== undefined && part !== '').join('：'))]
        .filter(part => part !== undefined && part !== '').join('\n')
      return { text, raw: result }
    }
    this.miner = new MemeMiner({
      notes: this.notes, hotwatch: this.hotwatch, gate: this.gate, search,
      model: createModelCall(ctx, { provider: miner.provider, model: miner.model, maxOutputTokens: miner.maxOutputTokens }),
      webMaterial: async term => await this.inbox.around(term, 900),
      settings: {
        minLikes: miner.minLikes, maxInputs: miner.maxInputs, maxNew: miner.maxNew, maxSearches: miner.maxSearches,
        termChars: config.notes.termChars, exampleChars: config.notes.textChars, meaningChars: miner.meaningChars,
        blocklist: config.blocklist, rawKept: miner.rawKept, commonShare: miner.commonShare, commonFrom: miner.commonFrom,
      },
      rawDir: join(paths.dir, 'raw'),
      logger: { info: (message) => { ctx.logger.info('%s', message) }, warn: (message) => { ctx.logger.warn('%s', message) } },
    })
  }

  /**
   * Remember the text of a web search or fetch a Session just ran, for the miner (when mining is on).
   * @param text - the tool result's text; the query and URL never reach this.
   */
  async feedWeb(text: string): Promise<void> {
    if (!this.config.enabled || !this.config.memes.enabled || !this.config.miner.enabled) return
    await this.inbox.add([text])
    this.ctx.logger.debug('speaking-style: web inbox took a page of %d characters', Array.from(text).length)
  }

  /** Stop a run in progress (its Bilibili reads end). */
  dispose(): void {
    this.abort.abort()
  }

  /**
   * Counts for the Settings overview, without any text; refreshed whenever the panel is read, after each run, and on the
   * schedule check.
   * @returns active and pending tone samples, the review mode, the last run's start, and the stock-line trend.
   */
  health(): StyleHealth {
    return { ...this.latest, review: this.config.review }
  }

  /** HotWatch's memes the owner did not block; empty when HotWatch or memes are off. */
  private async hotMemes(): Promise<HotMeme[]> {
    if (this.hotwatch === undefined) return []
    const [memes, blocked] = await Promise.all([this.hotwatch.memes(), this.notes.blocked()])
    return memes.filter(meme => !blocked.has(termKey(meme.title)))
  }

  /** The current card text, or undefined. */
  private async currentCard(): Promise<{ card: string | undefined; version: number }> {
    const last = (await this.notes.cards()).at(-1)
    return { card: last === undefined || last.card === '' ? undefined : last.card, version: last?.version ?? 0 }
  }

  /**
   * The block for a day.
   * @param day - `YYYY-MM-DD`, the rotation seed.
   * @param invite - invite the agent to write a card when there is none (its preset mounts `persona_update`).
   * @returns the block, its counts, and the card version it shows, or undefined when it is off or empty.
   */
  async block(day: string, invite: boolean): Promise<StyleBlock | undefined> {
    if (!this.config.enabled) return undefined
    const { memes: memesOn, traits: traitsOn, tone, persona } = this.config
    const [records, notes, card, hotMemes] = await Promise.all([this.store.all(), this.notes.notes(), this.currentCard(), this.hotMemes()])
    const hot = hotMemes.map(meme => meme.title)
    const block = renderStyleBlock({
      day, card: persona.enabled ? card.card : undefined, cardVersion: card.version, invite: persona.enabled && invite,
      traits: traitsOn.enabled ? notes.filter(note => note.kind === 'trait') : [],
      memes: memesOn.enabled ? notes.filter(note => note.kind === 'meme') : [], hot: memesOn.enabled ? hot : [],
      samples: tone.enabled ? records : [], toneShown: tone.maxShown, toneChars: tone.maxChars,
      memeIndex: memesOn.maxIndex, hotIndex: this.config.hotwatch.maxIndex,
    })
    return block === undefined ? undefined : { ...block, card: card.version }
  }

  /**
   * When the next scheduled run is due.
   * @returns epoch milliseconds; undefined while collection is off.
   */
  async nextRunAt(): Promise<number | undefined> {
    if (!this.config.enabled) return undefined
    return ((await this.collector.lastRun())?.at ?? 0) + this.config.everyHours * 3_600_000
  }

  /**
   * Run a collection and the meme miner when one is due and none is running.
   * @returns the tone collection's report, or undefined when nothing ran.
   */
  async runIfDue(): Promise<RunReport | undefined> {
    const at = await this.nextRunAt()
    if (at === undefined || Date.now() < at || this.collector.busy || this.miner.busy) {
      await this.panel()
      return undefined
    }
    const report = await this.collector.run('schedule', this.abort.signal)
    await this.mine()
    await this.panel()
    return report
  }

  /**
   * One meme-mining run over the public text of the last hours: QQ groups, Bilibili hot comments and hot-search words
   * (`ctx.biliHot`, absent until the bili package provides it), and the pages the main agent searched or fetched.
   * Nothing runs while mining is off or another run is going.
   * @returns the run's counts, or undefined when nothing ran.
   */
  async mine(): Promise<MineReport | undefined> {
    const { config } = this
    if (!config.enabled || !config.memes.enabled || !config.miner.enabled || this.miner.busy) return undefined
    const now = Date.now()
    const warn = (message: string): void => { this.ctx.logger.warn('%s', message) }
    const hot = optionalService(this.ctx, 'biliHot')
    const inputs = await gatherInputs({
      qq: this.ctx.get('qq'), hot: isHotSource(hot) ? hot : undefined, web: await this.inbox.lines(),
      window: { hours: config.miner.windowHours, limit: config.miner.qqMessages, settleMs: config.qq.settleMinutes * 60_000 },
      sinceMs: now - config.miner.windowHours * 3_600_000, now, warn,
    })
    const report = await this.miner.run(inputs, this.abort.signal)
    await this.saveMine(report)
    return report
  }

  private get mineFile(): string {
    return join(this.paths.dir, 'mine.json')
  }

  private async saveMine(report: MineReport): Promise<void> {
    try {
      await writeFile(this.mineFile, `${JSON.stringify(report)}\n`, { mode: 0o600 })
    } catch (error: unknown) {
      this.ctx.logger.warn('speaking-style: could not save the miner report: %s', error instanceof Error ? error.message : String(error))
    }
  }

  private async lastMine(): Promise<MineReport | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.mineFile, 'utf8'))
      return typeof parsed === 'object' && parsed !== null && 'at' in parsed && typeof parsed.at === 'number' ? parsed as MineReport : null
    } catch {
      return null
    }
  }

  /**
   * Everything the Settings section shows.
   * @returns the samples, notes, HotWatch's index, card versions, the last runs, the next run, and the trend.
   */
  async panel(): Promise<StylePanel> {
    const [records, notes, cards, lastRun, trend, next, hot, lastMine] = await Promise.all([
      this.store.live(), this.notes.notes(), this.notes.cards(), this.collector.lastRun(),
      readTrend(this.paths.ticsFile, join(this.paths.dir, 'answers.json')), this.nextRunAt(), this.hotMemes(), this.lastMine(),
    ])
    this.latest = {
      kept: records.filter(record => record.status === 'active').length,
      pending: records.filter(record => record.status === 'pending').length,
      review: this.config.review, lastRefreshAt: lastRun?.at ?? null, ticTrend: ticTrend(trend),
    }
    const { config } = this
    /* v8 ignore next -- a live record always has a reply. */
    const replyOf = (reply: string | undefined): string => reply ?? ''
    return {
      enabled: config.enabled,
      parts: {
        tone: config.tone.enabled, memes: config.memes.enabled, traits: config.traits.enabled, persona: config.persona.enabled,
        miner: config.memes.enabled && config.miner.enabled,
      },
      review: config.review,
      limits: {
        maxActive: config.maxActive, maxOwner: config.maxOwner,
        maxMemes: config.memes.maxIndex, maxTraits: config.traits.max, cardChars: config.persona.maxChars,
      },
      samples: records.map(record => ({
        id: record.id, source: record.source, owner: record.owner, status: record.status === 'pending' ? 'pending' : 'active', addedAt: record.addedAt,
        ...record.prompt === undefined ? {} : { prompt: record.prompt }, reply: replyOf(record.reply), origin: record.origin,
      })),
      notes,
      hot: hot.slice(0, config.hotwatch.maxIndex).map(meme => ({ title: meme.title, heat: meme.heat })),
      cards,
      running: this.collector.busy || this.miner.busy,
      lastRun: lastRun ?? null,
      lastMine,
      nextRunAt: next ?? null,
      trend,
    }
  }

  /**
   * Apply one edit the owner made on the Settings page. An owner's card edit, rollback, or deletion becomes the new
   * baseline and restarts the agent's revision wait.
   * @param input - `{ op: 'remove' | 'keep', id }`, `{ op: 'block', term }`, `{ op: 'card', card }`,
   * `{ op: 'rollback', version }`, or `{ op: 'deleteVersion', version }`, as the page sent it; validated here.
   * @returns the panel after the edit, or the refusal (`not_found`, `invalid_input`, `current_version`) with the unchanged panel.
   */
  async edit(input: unknown): Promise<StyleEditAnswer> {
    const body = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    const refuse = async (error: string): Promise<StyleEditAnswer> => ({ ok: false, error, panel: await this.panel() })
    try {
      switch (body['op']) {
        case 'remove': {
          const id = typeof body['id'] === 'string' ? body['id'] : ''
          const note = await this.notes.remove(id)
          const record = note === undefined ? await this.store.remove(id) : undefined
          /* v8 ignore next -- store.remove throws when the note is absent. */
          this.ctx.logger.info('speaking-style: the owner removed %s (%s); it is blocked', id, note?.kind ?? record?.source ?? 'sample')
          break
        }
        case 'keep': {
          const record = await this.store.keep(typeof body['id'] === 'string' ? body['id'] : '')
          this.ctx.logger.info('speaking-style: the owner kept %s (%s)', record.id, record.source)
          break
        }
        case 'block': {
          if (typeof body['term'] !== 'string' || termKey(body['term']) === '') return await refuse('invalid_input')
          await this.notes.block(body['term'])
          this.ctx.logger.info('speaking-style: the owner blocked a meme title')
          break
        }
        case 'card': {
          const card = typeof body['card'] === 'string' ? normalizeCard(body['card']) : undefined
          if (card === undefined || Array.from(card).length > this.config.persona.maxChars) return await refuse('invalid_input')
          const version = await this.notes.setCard({ card, author: 'owner', reason: card === '' ? 'deleted on the Settings page' : 'edited on the Settings page' })
          this.ctx.logger.info('speaking-style: the owner wrote card version %d (%d chars)', version.version, Array.from(card).length)
          break
        }
        case 'rollback': {
          const target = (await this.notes.cards()).find(card => card.version === body['version'])
          if (target === undefined) return await refuse('not_found')
          const version = await this.notes.setCard({ card: target.card, author: 'owner', reason: `rolled back to version ${String(target.version)}` })
          this.ctx.logger.info('speaking-style: the owner rolled the card back to version %d (now version %d)', target.version, version.version)
          break
        }
        case 'deleteVersion': {
          const version = body['version']
          const cards = await this.notes.cards()
          if (typeof version !== 'number' || !cards.some(card => card.version === version)) return await refuse('not_found')
          if (cards.at(-1)?.version === version) return await refuse('current_version')
          await this.notes.dropVersion(version)
          this.ctx.logger.info('speaking-style: the owner deleted card version %d from the history', version)
          break
        }
        default:
          return await refuse('invalid_input')
      }
    } catch (error: unknown) {
      if (!(error instanceof StyleError)) throw error
      return await refuse(error.code)
    }
    return { ok: true, panel: await this.panel() }
  }

  /**
   * Start a tone collection and then a meme-mining run without waiting for them; the panel says `running` until they
   * end. Nothing runs while off.
   * @returns the panel right after the start.
   */
  async collect(): Promise<StylePanel> {
    if (this.config.enabled && !this.collector.busy && !this.miner.busy) {
      void this.collector.run('manual', this.abort.signal)
        .then(async () => { await this.mine() })
        .then(async () => { await this.panel() })
        .catch((error: unknown) => { this.ctx.logger.warn('speaking-style: manual run failed: %s', error instanceof Error ? error.message : String(error)) })
    }
    return await this.panel()
  }

  /**
   * A `style_note` call: the platform comes from the calling Session's preset, the example must appear verbatim in what
   * that Session just read (QQ messages shown to a digest Session, or the results of the public-text tools in its log),
   * every field passes the note filter, and the guard allows the whole note.
   * @param input - the calling Session (and its log) and preset, the kind, the term, the meaning, the example, and related memes.
   * @returns `recorded`, `refreshed`, or `rejected` with a reason code.
   */
  async note(input: StyleNoteInput): Promise<WriteAnswer> {
    const answer = await this.admitNote(input)
    this.ctx.logger.info('speaking-style: style_note %s from session %s (%s): %s', input.kind, input.sessionId, input.preset, answer.status === 'rejected' ? `rejected (${answer.reason})` : answer.status)
    this.ctx.logger.debug('speaking-style: style_note %s', JSON.stringify({ term: input.term, meaning: input.meaning, example: input.example }))
    return answer
  }

  /** What a Session just read on `source`, for the verbatim check; undefined when the platform cannot be read. */
  private readOf(source: NoteSource, input: StyleNoteInput): string[] | undefined {
    const session = input.session === undefined ? [] : recentPublicText(input.session, source === 'web' ? { tools: WEB_TOOLS } : {})
    if (source !== 'qq') return input.session === undefined ? undefined : session
    const shown = this.ctx.get('qq')?.recentTextOf(input.sessionId)
    return shown === undefined && input.session === undefined ? undefined : [...shown ?? [], ...session]
  }

  private async admitNote(input: StyleNoteInput): Promise<WriteAnswer> {
    const reject = (reason: string): WriteAnswer => ({ status: 'rejected', reason })
    const on = input.kind === 'meme' ? this.config.memes.enabled : this.config.traits.enabled
    if (!this.config.enabled || !on) return reject('off')
    const source = this.config.notes.sources[input.preset]
    if (source === undefined) return reject('not_a_reader')
    // A trait describes a group's talk; a web page has no group.
    if (source === 'web' && input.kind === 'trait') return reject('not_a_reader')
    const texts = this.readOf(source, input)
    if (texts === undefined) return reject('unavailable')
    const term = normalizeLine(input.term)
    const meaning = input.kind === 'meme' && input.meaning !== undefined ? normalizeLine(input.meaning) : undefined
    const example = normalizeLine(input.example)
    if (input.kind === 'meme' && (meaning === undefined || meaning === '')) return reject('meaning_missing')
    const { termChars, textChars } = this.config.notes
    const related = input.kind === 'meme'
      ? (input.related ?? []).map(normalizeLine).filter((other, index, all) => termKey(other) !== '' && termKey(other) !== termKey(term)
        && all.findIndex(candidate => termKey(candidate) === termKey(other)) === index
        && screenNote(other, termChars, this.config.blocklist) === undefined).slice(0, MAX_RELATED)
      : []
    const refused = screenNote(term, termChars, this.config.blocklist) ?? screenNote(example, textChars, this.config.blocklist)
      ?? (meaning === undefined ? undefined : screenNote(meaning, textChars, this.config.blocklist))
    if (refused !== undefined) return reject(refused)
    if (!texts.some(text => normalizeLine(text).includes(example))) return reject('not_verbatim')
    const refusal = await this.gate.check([term, meaning ?? '', example, ...related].join('\n'), 'style_note', input.sessionId)
    if (refusal !== undefined) return reject(refusal)
    const outcome = await this.notes.note({
      kind: input.kind, term, ...meaning === undefined ? {} : { meaning }, example, source,
      ...related.length === 0 ? {} : { related }, ...input.kind === 'meme' ? { meaningSource: 'agent' as const } : {},
    })
    if (outcome === 'blocked') return reject('removed')
    await this.panel()
    return { status: outcome === 'added' ? 'recorded' : 'refreshed' }
  }

  /**
   * A `meme_lookup` call: the groups' own memes first, then HotWatch.
   * @param term - the meme as the index lists it (or one of its `related` terms).
   * @returns the meaning and where it came from, or `found: false`.
   */
  async lookup(term: string): Promise<LookupAnswer> {
    if (!this.config.enabled || !this.config.memes.enabled) return { found: false }
    const key = termKey(term)
    const memes = (await this.notes.notes()).filter(candidate => candidate.kind === 'meme')
    const note = memes.find(candidate => termKey(candidate.term) === key)
      ?? memes.find(candidate => candidate.related?.some(other => termKey(other) === key) ?? false)
    if (note !== undefined) {
      return {
        found: true, from: 'groups', term: note.term, meaning: note.meaning ?? '', example: note.example,
        ...note.related === undefined ? {} : { related: [...note.related] }, source: note.source,
        ...note.meaningSource === undefined ? {} : { meaningSource: note.meaningSource },
      }
    }
    if ((await this.notes.blocked()).has(key)) return { found: false }
    const hot = await this.hotwatch?.lookup(term)
    return hot === undefined ? { found: false } : { found: true, from: 'hotwatch', term: hot.title, meaning: hot.summary }
  }

  /**
   * A `persona_update` call: at most `persona.maxChars` characters, the note filter, the guard, and at least
   * `persona.minIntervalHours` since the last version (the agent's or the owner's; an owner edit on the Settings page
   * is never limited). The owner is told which version it became and how much changed, never the text, through
   * `ctx.ownerNotifier`, whose channel holds the notice while the owner sleeps.
   * @param input - the whole card, a one-line reason, and the writing Session.
   * @returns `recorded`, or `rejected` with a reason code.
   */
  async updateCard(input: { readonly card: string; readonly reason: string; readonly sessionId?: string }): Promise<WriteAnswer> {
    const reject = (reason: string): WriteAnswer => {
      this.ctx.logger.info('speaking-style: persona_update rejected (%s)', reason)
      return { status: 'rejected', reason }
    }
    if (!this.config.enabled || !this.config.persona.enabled) return reject('off')
    const card = normalizeCard(input.card)
    const refused = screenNote(card.replace(/\s+/gu, ' '), this.config.persona.maxChars, this.config.blocklist)
    if (refused !== undefined) return reject(refused)
    const last = (await this.notes.cards()).at(-1)
    if (last !== undefined && Date.now() - last.at < this.config.persona.minIntervalHours * 3_600_000) return reject('too_soon')
    const reason = Array.from(normalizeLine(input.reason)).slice(0, 120).join('')
    const refusal = await this.gate.check(`${card}\n${reason}`, 'persona', input.sessionId)
    if (refusal !== undefined) return reject(refusal)
    const version = await this.notes.setCard({ card, author: 'agent', reason })
    const before = Array.from(last?.card ?? '').length
    const after = Array.from(card).length
    this.ctx.logger.info('speaking-style: persona card version %d by the agent (%d → %d chars)', version.version, before, after)
    const notifier = this.ctx.get('ownerNotifier')
    if (notifier !== undefined) {
      await notifier.send({
        title: `人设卡更新到第 ${String(version.version)} 版`, body: `${String(before)} → ${String(after)} 字（设置 → 说话风格 可回滚）`,
        safety: true, origin: 'speaking-style (the persona card; size only)',
      }).catch((error: unknown) => { this.ctx.logger.warn('speaking-style: card notice failed: %s', error instanceof Error ? error.message : String(error)) })
    }
    return { status: 'recorded' }
  }
}

const isHotSource = (value: object | undefined): value is HotSource =>
  value !== undefined && 'comments' in value && typeof value.comments === 'function' && 'words' in value && typeof value.words === 'function'

/** A card with its lines trimmed and empty lines collapsed. */
function normalizeCard(text: string): string {
  return text.split('\n').map(line => line.trim()).filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== '')).join('\n').trim()
}
