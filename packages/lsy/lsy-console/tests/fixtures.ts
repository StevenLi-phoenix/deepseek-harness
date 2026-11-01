/** Shared Host test fixtures: a connection double that captures routes, loopback services to probe, and a Claude Code double. */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { CcOutcome, ClaudeCodeService } from '../src/claude-code.ts'
import type { CcView } from '../src/views.ts'

interface Route {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** A loopback HTTP service that answers a fixed status per path (404 elsewhere), or never answers. */
export class FakeService {
  private server: Server | undefined
  readonly seen: string[] = []
  url = ''

  /** @param answers - status by path; `hang` paths never respond. */
  constructor(private readonly answers: Record<string, number | 'hang'> = {}) {}

  async start(): Promise<string> {
    const sockets = new Set<import('node:net').Socket>()
    this.server = createServer((request, response) => {
      this.seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
      const answer = this.answers[request.url ?? ''] ?? 404
      if (answer === 'hang') return
      response.writeHead(answer).end('{}')
    })
    this.server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    this.stop = async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => this.server!.close(() => { resolve() }))
    }
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  stop: () => Promise<void> = () => Promise.resolve()
}

/** A free loopback port nobody listens on. */
export async function closedUrl(): Promise<string> {
  const probe = new FakeService()
  const url = await probe.start()
  await probe.stop()
  return url
}

/** An in-memory `ctx.lsyClaudeCode`: the sessions it lists and the calls it records. */
export class FakeClaudeCode implements ClaudeCodeService {
  enabled = true
  view_: CcView = { enabled: true, login: 'token', sessions: [], maxSessions: 3, started: [] }
  readonly calls: string[] = []
  next: CcOutcome = { ok: true }

  view(): Promise<CcView> {
    return Promise.resolve(this.view_)
  }

  start(name: string, task: string | undefined): Promise<CcOutcome> {
    this.calls.push(`start ${name}${task === undefined ? '' : ` ${task}`}`)
    return Promise.resolve(this.next)
  }

  stop(name: string): Promise<CcOutcome> {
    this.calls.push(`stop ${name}`)
    return Promise.resolve(this.next)
  }
}

/**
 * A temporary directory, removed by the teardown list.
 * @param cleanups - the test's teardown list.
 * @returns the directory.
 */
export function tempDir(cleanups: Array<() => void | Promise<void>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lsy-console-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Collected log lines of a context. */
export function captureLogs(ctx: Context): string[] {
  const lines: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { lines.push(`${message.type} ${String(message.args[0])}`) } })
  return lines
}

/** Options of {@link mountConsole}. */
export interface MountOptions {
  /** The context to mount on; a new one by default. */
  ctx?: Context
  config?: Record<string, unknown>
}

/**
 * Mount the plugin on a context with a connection double.
 * @param options - context and configuration overrides.
 * @returns the context, captured routes, log lines, and a `call()` that drives a route.
 */
export async function mountConsole(options: MountOptions = {}) {
  const ctx = options.ctx ?? new Context()
  const logs = captureLogs(ctx)
  const routes: Route[] = []
  ctx.provide('connection', { fetch: { register: (route: Route) => { routes.push(route); return () => Promise.resolve() } } } as never)
  const config = plugin.Config({
    bili: { url: 'http://127.0.0.1:1' },
    ams: { url: '' },
    probeTimeoutMs: 300,
    ...options.config,
  } as never)
  plugin.apply(ctx, config)
  const call = async (path: string, init: { method?: string; body?: unknown; contentType?: string | null; raw?: string } = {}) => {
    const route = routes.find(entry => entry.path === path)
    if (route === undefined) throw new Error(`route ${path} not registered`)
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init.contentType !== null && method === 'POST') headers['content-type'] = init.contentType ?? 'application/json'
    const body = method === 'POST' ? (init.raw ?? JSON.stringify(init.body ?? {})) : undefined
    return route.fetch(new Request(`http://127.0.0.1${path}`, { method, headers, ...body === undefined ? {} : { body } }))
  }
  return { ctx, routes, logs, call, config }
}
