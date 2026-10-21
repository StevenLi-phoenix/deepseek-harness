---
description: "GitHub polling sensor for the lsy event bus: new releases, tags, branch commits, and notification-thread updates from configured repositories and from watches the agent creates at run time, polled with conditional requests so unchanged repositories cost no rate limit."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-github-sensor

English | [中文](README.zh.md)

## Summary

Watch any GitHub repository you can read, including ones where you cannot install a webhook, and hear about new releases, tags, commits, and notification updates within a minute. Repositories come from the configuration or from the agent itself through `watch_create`. Each poll is a conditional request, so an unchanged repository costs nothing against an authenticated rate limit. The first poll of a new watch only records what already exists, so adding a watch never floods you. Polling pauses on rate limits and resumes on its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `@deepseek-ai/dsh-lsy-event-bus` and give it two tokens: a fine-grained read-only token as `LSY_GITHUB_TOKEN` for repositories and, for notifications, a classic token with only the `notifications` scope as `LSY_GITHUB_NOTIFICATIONS_TOKEN` (the notifications API accepts classic tokens only). List repositories in the configuration, or let the agent add them with `@deepseek-ai/dsh-lsy-tool-watch`.

### When to choose it

Choose it when webhooks are unavailable or you do not own the repository. Watching a repository on GitHub routes its issues, pull requests, and discussions into `/notifications`, which this sensor follows. Avoid it for sub-minute latency; use a webhook adapter instead.

### Minimal configuration

```yaml
- insert:
    - id: lsy-github-sensor
      name: '@deepseek-ai/dsh-lsy-github-sensor'
      config:
        repos:
          - repo: deepseek-ai/deepseek-harness
            watch: [releases, tags]
          - repo: octo/service
            watch: [commits]
            branch: main
```

The row needs no `config` at all when the agent creates every watch.

| Field | Default | Meaning |
|---|---|---|
| `repos[].repo` | required | `owner/name` |
| `repos[].watch` | `[releases]` | Any of `releases`, `commits`, `tags`, published in this order |
| `repos[].branch` | default branch | Branch for `commits` |
| `notifications` | `true` | Follow `/notifications`; without the notifications token the stream is skipped after one info log |
| `intervalMs` | `60000` | Poll period; `X-Poll-Interval` can stretch the notifications stream |
| `tokenEnv` / `notificationsTokenEnv` | `LSY_GITHUB_TOKEN` / `LSY_GITHUB_NOTIFICATIONS_TOKEN` | Credential references |
| `perPage` | `20` | Items per list request; more new items than this between polls are missed |
| `maxTextChars` | `2000` | Characters of release notes and commit messages kept |
| `maxSeenPerStream` | `200` | Seen ids remembered per stream |
| `timeoutMs` | `20000` | Per-request deadline |
| `apiBase` | `https://api.github.com` | REST origin |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-github-sensor) is the exhaustive source for every accepted field.

### Run-time watches

`ctx.lsyGithubSensor` exposes what `watch_create`, `watch_list`, and `watch_delete` use:

- `watch(ref, { repo, watch, branch? })` — validates `owner/name`, a non-empty subset of streams, and a branch only with `commits`; stores the watch under `ref` (replacing one with the same ref) and starts a poll right away so the baseline is recorded at once.
- `unwatch(ref)` — returns whether the watch existed and deletes the cursors of streams nobody polls anymore, so watching again records a fresh baseline instead of replaying what happened in between.
- `watchedRepos()` — configuration and agent watches with `origin`, `ref`, and per-stream baseline and latest poll outcome.
- `probe(repo, signal?)` — `GET /repos/{owner}/{name}` with the repository token when one resolves; returns `{ ok: true, fullName, private, defaultBranch }` or `{ ok: false, status, message }` (status 0 without a response) and never throws.
- `credentialStatus()` — whether each token reference resolves and whether notification polling is on; never the values.
- `cursor(stream)` and `pollStatus(stream)` — one stream's stored cursor and latest poll outcome.

### Events

| Kind | Key | Subject | Actor |
|---|---|---|---|
| `github.release` | `<repo>:release:<id>` | repository | release author |
| `github.tag` | `<repo>:tag:<name>` | repository | — |
| `github.commit` | `<repo>:commit:<sha>` | repository | GitHub login, else git author name |
| `github.notification.<type>` | `notification:<thread>:<updated_at>` | repository | — |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One tick polls the union of configured and agent-created repositories, each stream once even when several watches name it, and never overlaps the previous tick; a watch created during a tick gets a follow-up tick right after it. Each stream keeps a cursor in the `lsy_github_sensor` storage domain, keyed `repo:<owner/name>:<kind>`, or `repo:<owner/name>:commits@<branch>` when a branch is set so two branches never share one: `ETag` and `Last-Modified` validators, the newest seen ids, a baseline flag, and the next allowed poll from `X-Poll-Interval`. A 304 changes nothing. A 200 publishes unseen items oldest first and only then advances the cursor; if a publish fails, the validators are dropped so the next poll refetches and the bus deduplicates what already arrived. A response for a stream unwatched while its request was in flight is discarded. Drafts are ignored rather than marked seen, so their later publication still counts. A 403 or 429 carrying `retry-after` or an exhausted `x-ratelimit-reset` pauses all streams until then. Agent watches live in the `watches` table of the same domain.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, run-time watches, probe, tick, conditional fetch, rate-limit backoff |
| [`src/github.ts`](src/github.ts) | Response parsing and event mapping |
| [`src/storage.ts`](src/storage.ts) | Cursor and watch tables |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md). `tests/fake-github.ts` is a REST double with ETag, Last-Modified, X-Poll-Interval, and rate-limit behavior; the `@deepseek-ai/dsh-lsy-tool-watch` tests reuse it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy event bus](../lsy-event-bus/README.md) — what happens to published events
- [Watch tools](../lsy-tool-watch/README.md) — how the agent creates watches
- [GitHub webhook adapter](../../experimental/webhook-github/README.md) — the push alternative when you own the repository

-----

<a id="model-experience"></a>
## Model Experience

### Event data in Session prompts

#### What the model sees

This sensor adds no prompt or tool of its own. Its events reach a model only through a `session` subscription of `@deepseek-ai/dsh-lsy-event-bus`, as entries of `events_json` with `kind`, `subject`, `title`, `url`, `actor`, `occurredAt`, and `text` (release notes or a commit message, at most `maxTextChars` characters); `watch_list` from `@deepseek-ai/dsh-lsy-tool-watch` reports each stream's `baseline` and `last_poll`.

#### Token effect

Release notes and commit messages dominate: up to `maxTextChars` characters per event, cut again by the subscription's own `maxTextChars` and `maxPromptEvents`.

#### KV Cache effect

Independent of polling: events only ever open new Sessions, which establish rather than invalidate a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Bounded catch-up** — more than `perPage` new items in one stream between two polls are partly missed.
- **Poll status is in memory** — `lastPoll` starts empty after a restart until each stream is polled again.
- **No read marking** — notification threads stay unread on GitHub; each thread update is a new event.
- **Classic token for notifications** — GitHub's notifications API does not accept fine-grained tokens.
