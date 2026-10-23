/**
 * GitHub webhook deliveries mapped into bus events. Releases, tags, and
 * default-branch commits get the same keys polling gives them, so a change
 * seen both ways is one event; webhooks bring it within seconds and polling
 * still covers a missed delivery. Other repository events become
 * `github.<event>.<action>` kinds keyed by delivery.
 */

import { clip, type LsyEventInput } from '@deepseek-ai/dsh-lsy-event-bus'
import { z } from 'zod'
import { occurredAt, parseRelease, releaseEvent, tagEvent } from './github.ts'

/** The adapter's event as `dsh-webhook-github` delivers it. */
export interface GithubDelivery {
  /** `X-GitHub-Event`, such as `push`. */
  readonly name: string
  readonly payload: unknown
}

/** Deliveries about the App itself, not a repository, and per-job CI chatter that workflow_run already summarizes. */
const HOUSEKEEPING: ReadonlySet<string> = new Set([
  'ping', 'installation', 'installation_repositories', 'installation_target', 'github_app_authorization', 'workflow_job',
])

const envelope = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string(), default_branch: z.string().optional(), html_url: z.string().optional() }),
  sender: z.object({ login: z.string() }).nullable().optional(),
})

const pushSchema = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  commits: z.array(z.object({
    id: z.string(),
    message: z.string(),
    timestamp: z.string().optional(),
    url: z.string(),
    author: z.object({ name: z.string().optional(), username: z.string().optional() }).optional(),
  })).optional(),
})

const linked = z.object({
  number: z.number().optional(), title: z.string().optional(), html_url: z.string().optional(), body: z.string().nullable().optional(),
})
const detailSchema = z.object({
  number: z.number().optional(),
  pull_request: linked.optional(),
  issue: linked.optional(),
  comment: z.object({ body: z.string().nullable().optional(), html_url: z.string().optional() }).optional(),
  review: z.object({ state: z.string().optional(), body: z.string().nullable().optional(), html_url: z.string().optional() }).optional(),
  workflow_run: z.object({
    name: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    head_branch: z.string().nullable().optional(),
    html_url: z.string().optional(),
  }).optional(),
})

type Detail = z.infer<typeof detailSchema>

/** Title, link, and body excerpt of a non-polled event; undefined drops it. */
/** What the bus shows for one non-polled event. */
interface Described {
  title: string
  url?: string | undefined
  text?: string | null | undefined
}

function describe(name: string, action: string | undefined, detail: Detail): Described | undefined {
  const pr = detail.pull_request
  const issue = detail.issue
  switch (name) {
    case 'pull_request':
      return { title: `PR #${detail.number ?? pr?.number ?? '?'} ${action ?? 'updated'}: ${pr?.title ?? ''}`.trimEnd(), url: pr?.html_url, text: pr?.body }
    case 'issues':
      return { title: `issue #${issue?.number ?? '?'} ${action ?? 'updated'}: ${issue?.title ?? ''}`.trimEnd(), url: issue?.html_url, text: issue?.body }
    case 'issue_comment':
      return { title: `comment on #${issue?.number ?? '?'}: ${issue?.title ?? ''}`.trimEnd(), url: detail.comment?.html_url ?? issue?.html_url, text: detail.comment?.body }
    case 'pull_request_review':
      return { title: `review ${detail.review?.state ?? action ?? ''} on PR #${pr?.number ?? '?'}: ${pr?.title ?? ''}`.trimEnd(), url: detail.review?.html_url ?? pr?.html_url, text: detail.review?.body }
    case 'check_suite':
    case 'check_run':
      // Only a finished check says anything; requested and in-progress ones arrive several times per push.
      return action === 'completed' ? { title: `${name.replace('_', ' ')} completed` } : undefined
    case 'workflow_run': {
      const run = detail.workflow_run
      // Requested and in-progress runs say nothing yet; only a finished run has news.
      if (action !== 'completed' || run?.conclusion == null) return undefined
      return { title: `workflow ${run.name ?? ''} ${run.conclusion}${run.head_branch ? ` on ${run.head_branch}` : ''}`.replace(/\s+/g, ' '), url: run.html_url }
    }
    default:
      return { title: `${name}${action === undefined ? '' : ` ${action}`}` }
  }
}

/**
 * Bus events of one verified delivery.
 * @param delivery - event name and payload.
 * @param deliveryId - `X-GitHub-Delivery`, the key of events polling never sees.
 * @param maxTextChars - characters of bodies kept.
 * @returns events to publish; empty for housekeeping, unexpected shapes, and changes polling does not report.
 */
export function deliveryEvents(delivery: GithubDelivery, deliveryId: string, maxTextChars: number): LsyEventInput[] {
  if (HOUSEKEEPING.has(delivery.name)) return []
  const head = envelope.safeParse(delivery.payload)
  if (!head.success) return []
  const repo = head.data.repository.full_name
  const action = head.data.action
  const actor = head.data.sender?.login

  switch (delivery.name) {
    case 'release': {
      const release = parseRelease((delivery.payload as { release?: unknown }).release)
      return action === 'published' && release !== undefined ? [releaseEvent(repo, release, maxTextChars)] : []
    }
    case 'create': {
      const { ref_type: refType, ref } = delivery.payload as { ref_type?: unknown; ref?: unknown }
      return refType === 'tag' && typeof ref === 'string' ? [tagEvent(repo, { name: ref, commit: { sha: '' } })] : []
    }
    case 'push': {
      const push = pushSchema.safeParse(delivery.payload)
      const branch = head.data.repository.default_branch
      if (!push.success || push.data.deleted === true || branch === undefined || push.data.ref !== `refs/heads/${branch}`) return []
      return (push.data.commits ?? []).map((commit): LsyEventInput => {
        const firstLine = commit.message.split('\n', 1).join('').trim()
        const author = commit.author?.username ?? commit.author?.name
        return {
          source: 'github',
          kind: 'github.commit',
          key: `${repo}:commit:${commit.id}`,
          subject: repo,
          title: firstLine === '' ? `commit ${commit.id.slice(0, 7)}` : firstLine,
          url: commit.url,
          ...(author === undefined ? {} : { actor: author }),
          ...(commit.message === '' ? {} : { text: clip(commit.message, maxTextChars) }),
          ...occurredAt(commit.timestamp),
        }
      })
    }
    default: {
      const detail = detailSchema.safeParse(delivery.payload)
      const described = describe(delivery.name, action, detail.success ? detail.data : {})
      if (described === undefined) return []
      return [{
        source: 'github',
        kind: `github.${delivery.name}${action === undefined ? '' : `.${action}`}`,
        key: `${repo}:${delivery.name}:${deliveryId}`,
        subject: repo,
        title: described.title,
        url: described.url ?? head.data.repository.html_url,
        ...(actor === undefined ? {} : { actor }),
        ...(described.text ? { text: clip(described.text, maxTextChars) } : {}),
      }]
    }
  }
}
