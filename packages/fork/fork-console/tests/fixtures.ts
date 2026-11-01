/** Shared Host test fixtures: a connection double that captures routes, loopback services to probe, and a fake tmux. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { ClaudeCode } from '../src/claude-code.ts'

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

/**
 * A fake tmux binary: `list-sessions` prints the names in its state file, `new-session -s <name>` adds one,
 * and `kill-session -t <name>` removes it.
 * @param dir - directory to write into.
 * @returns the binary's path and the state file's.
 */
export function fakeTmux(dir: string): { tmux: string; state: string; log: string } {
  const tmux = join(dir, 'tmux')
  const state = join(dir, 'tmux-sessions')
  const log = join(dir, 'tmux-calls')
  writeFileSync(state, '')
  writeFileSync(tmux, `#!/bin/bash
echo "$*" >> '${log}'
shift 2
case "$1" in
  list-sessions) [ -s '${state}' ] && cat '${state}' || exit 1 ;;
  new-session) while [ "$1" != "-s" ]; do shift; done; echo "$2" >> '${state}' ;;
  kill-session) grep -vx "$3" '${state}' > '${state}.tmp'; mv '${state}.tmp' '${state}' ;;
esac
exit 0
`)
  chmodSync(tmux, 0o755)
  return { tmux, state, log }
}

/** A temporary service-account home, removed by `cleanup()`. */
export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'fork-console-'))
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.config', 'claude-code'), { recursive: true })
  return { home, cleanup: () => { rmSync(home, { recursive: true, force: true }) } }
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
  home?: string
}

/**
 * Mount the plugin on a context with a connection double.
 * @param options - context, configuration overrides, and the service account home.
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
    claudeCode: { sessionsDir: options.home === undefined ? '' : join(options.home, '.claude', 'sessions'), tmux: '/nonexistent/tmux' },
    ...options.config,
  } as never)
  const claudeCode = new ClaudeCode(config.claudeCode, options.home ?? '/nonexistent/home')
  plugin.mount(ctx, config, claudeCode)
  const call = async (path: string, init: { method?: string; body?: unknown; contentType?: string | null; raw?: string } = {}) => {
    const route = routes.find(entry => entry.path === path)
    if (route === undefined) throw new Error(`route ${path} not registered`)
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init.contentType !== null && method === 'POST') headers['content-type'] = init.contentType ?? 'application/json'
    const body = method === 'POST' ? (init.raw ?? JSON.stringify(init.body ?? {})) : undefined
    return route.fetch(new Request(`http://127.0.0.1${path}`, { method, headers, ...body === undefined ? {} : { body } }))
  }
  return { ctx, routes, logs, call, config, claudeCode }
}
