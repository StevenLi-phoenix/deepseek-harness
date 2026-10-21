/** GitHub REST response parsing and pure mapping into bus events. */
import { clip, type LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import { z } from 'zod'

const loginSchema = z.object({ login: z.string() }).nullable().optional()

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  html_url: z.string(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
  author: loginSchema,
})

const tagSchema = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string() }),
})

const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().optional(), date: z.string().optional() }).nullable().optional(),
  }),
  author: loginSchema,
})

const threadSchema = z.object({
  id: z.string(),
  reason: z.string(),
  updated_at: z.string(),
  subject: z.object({ title: z.string(), url: z.string().nullable().optional(), type: z.string() }),
  repository: z.object({ full_name: z.string(), html_url: z.string() }),
})

/** One published release. */
export type Release = z.infer<typeof releaseSchema>
/** One tag. */
export type Tag = z.infer<typeof tagSchema>
/** One commit on a branch. */
export type Commit = z.infer<typeof commitSchema>
/** One notification thread. */
export type Thread = z.infer<typeof threadSchema>

/**
 * Parse a list response, or report a body that is not the expected list.
 * @param schema - item schema; unknown fields are dropped.
 * @param body - decoded JSON body.
 * @returns items, or undefined for a malformed body.
 */
function parseList<T>(schema: z.ZodType<T>, body: unknown): T[] | undefined {
  const parsed = z.array(schema).safeParse(body)
  return parsed.success ? parsed.data : undefined
}

/** Releases visible to the token, without drafts so a later publication still counts as new. */
export const parseReleases = (body: unknown): Release[] | undefined =>
  parseList(releaseSchema, body)?.filter(release => release.draft !== true)
/** Tags, newest first as the API orders them. */
export const parseTags = (body: unknown): Tag[] | undefined => parseList(tagSchema, body)
/** Commits on one branch, newest first. */
export const parseCommits = (body: unknown): Commit[] | undefined => parseList(commitSchema, body)
/** Notification threads, most recently updated first. */
export const parseThreads = (body: unknown): Thread[] | undefined => parseList(threadSchema, body)

/** Parse an ISO timestamp, omitting the field when absent. */
function occurredAt(value: string | null | undefined): { occurredAt?: number } {
  if (value === null || value === undefined) return {}
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? {} : { occurredAt: parsed }
}

/**
 * Map a release.
 * @param repo - `owner/name`.
 * @param release - parsed release.
 * @param maxTextChars - characters of release notes kept.
 * @returns bus event keyed by release id.
 */
export function releaseEvent(repo: string, release: Release, maxTextChars: number): LsyEventInput {
  const name = release.name?.trim()
  const title = `${release.tag_name}${name && name !== release.tag_name ? ` — ${name}` : ''}${release.prerelease === true ? ' (pre-release)' : ''}`
  return {
    source: 'github',
    kind: 'github.release',
    key: `${repo}:release:${release.id}`,
    subject: repo,
    title,
    url: release.html_url,
    ...(release.author?.login === undefined ? {} : { actor: release.author.login }),
    ...(release.body ? { text: clip(release.body, maxTextChars) } : {}),
    ...occurredAt(release.published_at),
  }
}

/**
 * Map a tag.
 * @param repo - `owner/name`.
 * @param tag - parsed tag.
 * @returns bus event keyed by tag name.
 */
export function tagEvent(repo: string, tag: Tag): LsyEventInput {
  return {
    source: 'github',
    kind: 'github.tag',
    key: `${repo}:tag:${tag.name}`,
    subject: repo,
    title: `tag ${tag.name}`,
    url: `https://github.com/${repo}/tree/${encodeURIComponent(tag.name)}`,
  }
}

/**
 * Map a commit.
 * @param repo - `owner/name`.
 * @param commit - parsed commit.
 * @param maxTextChars - characters of the message kept.
 * @returns bus event keyed by sha.
 */
export function commitEvent(repo: string, commit: Commit, maxTextChars: number): LsyEventInput {
  const firstLine = commit.commit.message.split('\n', 1).join('').trim()
  const actor = commit.author?.login ?? commit.commit.author?.name
  return {
    source: 'github',
    kind: 'github.commit',
    key: `${repo}:commit:${commit.sha}`,
    subject: repo,
    title: firstLine === '' ? `commit ${commit.sha.slice(0, 7)}` : firstLine,
    url: commit.html_url,
    ...(actor === undefined ? {} : { actor }),
    ...(commit.commit.message === '' ? {} : { text: clip(commit.commit.message, maxTextChars) }),
    ...occurredAt(commit.commit.author?.date),
  }
}

/**
 * Map an updated notification thread; each update is a separate event.
 * @param thread - parsed thread.
 * @returns bus event keyed by thread id and update time.
 */
export function notificationEvent(thread: Thread): LsyEventInput {
  return {
    source: 'github',
    kind: `github.notification.${thread.subject.type.toLowerCase()}`,
    key: `notification:${thread.id}:${thread.updated_at}`,
    subject: thread.repository.full_name,
    title: `[${thread.reason}] ${thread.subject.title}`,
    url: htmlUrl(thread.subject.url, thread.repository.html_url),
    ...occurredAt(thread.updated_at),
  }
}

const API_RESOURCE = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits)\/([^/?#]+)$/

/**
 * Turn a REST resource URL into its github.com page.
 * @param apiUrl - `subject.url` of a notification.
 * @param fallback - repository page used for other resources.
 * @returns browser URL.
 */
export function htmlUrl(apiUrl: string | null | undefined, fallback: string): string {
  const match = apiUrl === null || apiUrl === undefined ? null : API_RESOURCE.exec(apiUrl)
  if (match === null) return fallback
  const page = { issues: 'issues', pulls: 'pull', commits: 'commit' }[match[2] as 'issues' | 'pulls' | 'commits']
  return `https://github.com/${match[1]}/${page}/${match[3]}`
}
