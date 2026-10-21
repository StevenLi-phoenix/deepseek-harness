/** In-memory GitHub REST double with ETag, Last-Modified, X-Poll-Interval, and rate-limit behavior. */
import type { Commit, Release, Thread } from '../src/github.ts'

/** One served resource; every `set()` bumps its validators. */
interface Route {
  body: unknown
  etag: string
  lastModified: string
  headers: Record<string, string>
  status: number
}

/** One request the double received. */
export interface RecordedRequest {
  path: string
  headers: Record<string, string>
  status: number
}

/** Serves `fetch` calls for one API origin. */
export class FakeGitHub {
  readonly requests: RecordedRequest[] = []
  private readonly routes = new Map<string, Route>()
  private version = 0

  constructor(readonly origin = 'https://api.github.test') {}

  /**
   * Serve `body` at `path` (pathname plus query) with fresh validators.
   * @param path - request path including the query string.
   * @param body - JSON body.
   * @param options - extra response headers or a non-200 status.
   */
  set(path: string, body: unknown, options: { headers?: Record<string, string>; status?: number } = {}): void {
    this.version += 1
    this.routes.set(path, {
      body,
      etag: `"v${this.version}"`,
      lastModified: new Date(Date.UTC(2026, 9, 21, 0, 0, this.version)).toUTCString(),
      headers: options.headers ?? {},
      status: options.status ?? 200,
    })
  }

  /** Requests made to one path, oldest first. */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter(request => request.path === path)
  }

  /** `fetch` replacement bound to this double. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const path = `${url.pathname}${url.search}`
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const route = url.origin === this.origin ? this.routes.get(path) : undefined
    const respond = (status: number, body: string | null, extra: Record<string, string> = {}): Response => {
      this.requests.push({ path, headers, status })
      return new Response(body, { status, headers: extra })
    }
    if (route === undefined) return respond(404, JSON.stringify({ message: 'Not Found' }), { 'content-type': 'application/json' })
    const validators = { 'etag': route.etag, 'last-modified': route.lastModified, ...route.headers }
    if (route.status !== 200) return respond(route.status, JSON.stringify(route.body), { 'content-type': 'application/json', ...route.headers })
    if (headers['if-none-match'] === route.etag || headers['if-modified-since'] === route.lastModified) {
      return respond(304, null, validators)
    }
    return respond(200, JSON.stringify(route.body), { 'content-type': 'application/json', ...validators })
  }
}

/** A release as the REST API returns it. */
export function release(id: number, overrides: Partial<Release> = {}): Release {
  return {
    id,
    tag_name: `v${id}.0.0`,
    name: `v${id}.0.0`,
    html_url: `https://github.com/octo/repo/releases/tag/v${id}.0.0`,
    body: `Notes for ${id}`,
    draft: false,
    prerelease: false,
    published_at: `2026-10-2${id % 10}T00:00:00Z`,
    author: { login: 'octocat' },
    ...overrides,
  }
}

/** A commit as the REST API returns it. */
export function commit(sha: string, message: string, login: string | null = 'octocat'): Commit {
  return {
    sha,
    html_url: `https://github.com/octo/repo/commit/${sha}`,
    commit: { message, author: { name: 'Octo Cat', date: '2026-10-21T00:00:00Z' } },
    author: login === null ? null : { login },
  }
}

/** A notification thread as the REST API returns it. */
export function thread(id: string, updatedAt: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    reason: 'subscribed',
    updated_at: updatedAt,
    subject: { title: `Issue ${id}`, url: `https://api.github.com/repos/octo/repo/issues/${id}`, type: 'Issue' },
    repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
    ...overrides,
  }
}
