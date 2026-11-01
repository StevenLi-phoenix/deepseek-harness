/**
 * The Settings route `/api/fork.presence`: the presence state and the buttons of the 勿扰 page (go to
 * sleep, wake, quiet until a time, clear the button, edit the daily window, send what is held back).
 * It sits under `/api`, so the connection's sign-in check guards it. Every action is checked against
 * a schema and logged with its outcome and duration; the answer never carries a token.
 */
import z from '@deepseek-ai/schemastery'
import { CLOCK_PATTERN, PRESENCE_PATH, type PresenceAction, type PresenceAnswer, type PresenceView, type QuietWindow } from './view.ts'

/** The slice of the connection service the route uses. */
export interface SettingsConnection {
  readonly fetch: {
    register(route: SettingsRoute): () => Promise<void>
  }
}

/** One route registration. */
export interface SettingsRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'POST')[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** What the route needs of the presence service. */
export interface SettingsPresence {
  view(): PresenceView
  setManual(asleep: boolean, until?: number): Promise<void>
  quietUntil(clock: string): Promise<number>
  clearManual(): Promise<void>
  setWindow(window: QuietWindow): Promise<void>
  flushNow(): Promise<number>
}

/** Settings options. */
export interface PresenceSettingsOptions {
  presence: SettingsPresence
  logger: { info(message: string): void; warn(message: string): void }
  /** Clock, replaceable in tests. */
  now?: () => number
}

const clock = z.string().pattern(CLOCK_PATTERN).required()

/** Request bodies; a field outside this schema is ignored. */
const actionSchema = z.union([
  z.object({ action: z.const('sleep.now').required() }),
  z.object({ action: z.const('wake.now').required() }),
  z.object({ action: z.const('quiet.until').required(), until: clock }),
  z.object({ action: z.const('manual.clear').required() }),
  z.object({ action: z.const('window.set').required(), enabled: z.boolean().required(), start: clock, end: clock }),
  z.object({ action: z.const('flush').required() }),
])

const HEADERS = { 'cache-control': 'no-store' }

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: HEADERS })
}

/** The route's logic, kept apart from the service so it can be tested with a fake one. */
export class PresenceSettings {
  private readonly now: () => number

  /** @param options - the presence service, logger, and test overrides. */
  constructor(private readonly options: PresenceSettingsOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * The route for the connection service.
   * @returns the registration.
   */
  route(): SettingsRoute {
    return { path: PRESENCE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => this.handle(request) }
  }

  private answer(flushed: number | null = null): Response {
    const body: PresenceAnswer = { view: this.options.presence.view(), flushed }
    return Response.json(body, { headers: HEADERS })
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return this.answer()
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return failure(415, 'expected application/json')
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return failure(400, 'body is not JSON')
    }
    let action: PresenceAction
    try {
      action = actionSchema(body as never)
    } catch {
      return failure(400, 'unknown action or bad field')
    }
    const startedAt = this.now()
    const response = await this.perform(action)
    this.options.logger.info(`fork-presence: settings ${action.action} ${response.status < 300 ? 'ok' : `refused (${response.status})`} (${this.now() - startedAt} ms)`)
    return response
  }

  private async perform(action: PresenceAction): Promise<Response> {
    const { presence } = this.options
    switch (action.action) {
      case 'sleep.now':
        await presence.setManual(true)
        return this.answer()
      case 'wake.now':
        await presence.setManual(false)
        return this.answer()
      case 'quiet.until':
        await presence.quietUntil(action.until)
        return this.answer()
      case 'manual.clear':
        await presence.clearManual()
        return this.answer()
      case 'window.set':
        if (action.enabled && action.start === action.end) return failure(400, 'the window must not start and end at the same time')
        await presence.setWindow({ enabled: action.enabled, start: action.start, end: action.end })
        return this.answer()
      case 'flush':
        return this.answer(await presence.flushNow())
      default:
        return failure(400, 'unknown action')
    }
  }
}
