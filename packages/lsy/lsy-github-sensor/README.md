---
description: "GitHub polling sensor for the lsy event bus: new releases, tags, branch commits, and notification-thread updates, polled with conditional requests so unchanged repositories cost no rate limit."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-github-sensor

English | [中文](README.zh.md)

## Summary

Watch any GitHub repository you can read, including ones where you cannot install a webhook, and hear about new releases, tags, commits, and notification updates within a minute. Each poll is a conditional request, so an unchanged repository costs nothing against an authenticated rate limit. The first poll only records what already exists, so turning the sensor on never floods you. Polling pauses on rate limits and resumes on its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `@deepseek-ai/dsh-lsy-event-bus`, list repositories, and give it two tokens: a fine-grained read-only token as `LSY_GITHUB_TOKEN` for repositories and, for notifications, a classic token with only the `notifications` scope as `LSY_GITHUB_NOTIFICATIONS_TOKEN` (the notifications API accepts classic tokens only).

### When to choose it

Choose it when webhooks are unavailable or you do not own the repository. Watching a repository on GitHub routes its issues, pull requests, and discussions into `/notifications`, which this sensor follows. Avoid it for sub-minute latency; use a webhook adapter instead.

### Minimal configuration

```yaml
- insert:
    - id: lsy-github-sensor
      name: '@deepseek-ai/dsh-lsy-github-sensor'
      config:
        notifications: true
        repos:
          - repo: deepseek-ai/deepseek-harness
            watch: [releases, tags]
          - repo: octo/service
            watch: [commits]
            branch: main
```

| Field | Default | Meaning |
|---|---|---|
| `repos[].repo` | required | `owner/name` |
| `repos[].watch` | `[releases]` | Any of `releases`, `commits`, `tags`, published in this order |
| `repos[].branch` | default branch | Branch for `commits` |
| `notifications` | `false` | Follow `/notifications` (needs the notifications token) |
| `intervalMs` | `60000` | Poll period; `X-Poll-Interval` can stretch the notifications stream |
| `tokenEnv` / `notificationsTokenEnv` | `LSY_GITHUB_TOKEN` / `LSY_GITHUB_NOTIFICATIONS_TOKEN` | Credential references |
| `perPage` | `20` | Items per list request; more new items than this between polls are missed |
| `maxTextChars` | `2000` | Characters of release notes and commit messages kept |
| `maxSeenPerStream` | `200` | Seen ids remembered per stream |
| `timeoutMs` | `20000` | Per-request deadline |
| `apiBase` | `https://api.github.com` | REST origin |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidshlsy-github-sensor) is the exhaustive source for every accepted field.

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

One tick polls every stream in order and never overlaps the previous tick. Each stream keeps a cursor in the `lsy_github_sensor` storage domain: `ETag` and `Last-Modified` validators, the newest seen ids, a baseline flag, and the next allowed poll from `X-Poll-Interval`. A 304 changes nothing. A 200 publishes unseen items oldest first and only then advances the cursor; if a publish fails, the validators are dropped so the next poll refetches and the bus deduplicates what already arrived. Drafts are ignored rather than marked seen, so their later publication still counts. A 403 or 429 carrying `retry-after` or an exhausted `x-ratelimit-reset` pauses all streams until then.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, tick, conditional fetch, rate-limit backoff |
| [`src/github.ts`](src/github.ts) | Response parsing and event mapping |
| [`src/storage.ts`](src/storage.ts) | Cursor table |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy event bus](../lsy-event-bus/README.md) — what happens to published events
- [GitHub webhook adapter](../../experimental/webhook-github/README.md) — the push alternative when you own the repository

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-lsy-event-bus`: this sensor contributes no prompt or tool; a session subscription decides which of its events reach a model.

#### KV Cache effect

Independent: polling and publishing never touch a model request.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Bounded catch-up** — more than `perPage` new items in one stream between two polls are partly missed.
- **No read marking** — notification threads stay unread on GitHub; each thread update is a new event.
- **Classic token for notifications** — GitHub's notifications API does not accept fine-grained tokens.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md). `tests/fake-github.ts` is a REST double with ETag, Last-Modified, X-Poll-Interval, and rate-limit behavior.

</details>
