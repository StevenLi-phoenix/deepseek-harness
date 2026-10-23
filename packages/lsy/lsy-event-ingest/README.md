---
description: "Authenticated POST /hooks/lsy route through which the owner's own services push events into the lsy event bus: one bearer token per source, the token (never the body) sets the source, bounded fields, and dedupe by key."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-ingest

English | [中文](README.zh.md)

## Summary

Let your own services tell the agent when something needs attention, with one authenticated HTTP POST: a pipeline that failed, a job that finished, a disk that filled. Each service has its own token, and the token, not the request body, decides which source an event comes from, so a leaked token cannot pose as GitHub or as another service. The event bus then dedupes the event and routes it to a notification or an unattended agent Session. Nothing is queued here; a service that gets no answer retries with the same `key`.

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

Mount the route in the process that runs `@deepseek-ai/dsh-lsy-event-bus` and the Host web server, give every pushing service its own token in the credential store, and add a bus subscription for its events. The lsy event bundle mounts it with one source, `kaorou`, whose token `LSY_INGEST_TOKEN_KAOROU` lives in `$DSH_HOME/.env`; its `kaorou` subscription starts a diagnosis Session for `kaorou.*` events ([bundle patch](../../../lsy/bundles/event/cordis.patch.yml)).

### When to choose it

Choose it when a service you run should wake the agent the moment it has news. Avoid it for GitHub, which `@deepseek-ai/dsh-lsy-github-sensor` already covers, and for things the agent can watch itself, which `monitor_start` from `@deepseek-ai/dsh-lsy-tool-monitor` handles.

### Minimal configuration

```yaml
- id: lsy-event-ingest
  name: '@deepseek-ai/dsh-lsy-event-ingest'
  config:
    sources:
      - id: kaorou
        tokenEnv: LSY_INGEST_TOKEN_KAOROU
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `/hooks/lsy` | Route path; it must start with `/hooks/` and not end with `/` |
| `sources` | `[]` | Services allowed to push; with none, every request gets 503 |
| `sources[].id` | required | Source id on the bus: lowercase letters, digits, and hyphens, at most 32 characters, unique, never `github` or `schedule` |
| `sources[].tokenEnv` | required | Credential reference holding that source's bearer token |
| `maxBodyBytes` | `65536` | Largest accepted body, at least 1024 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-event-ingest) is the exhaustive source for every accepted field.

Make each token a long random value, for example `openssl rand -hex 32`, store it in `$DSH_HOME/.env` under the name `tokenEnv` gives, and give the same value to the pushing service. Restart the host after editing `.env`. A source whose token is unset or empty cannot push.

### Push an event

```sh
curl -sS -X POST http://127.0.0.1:3081/hooks/lsy \
  -H "Authorization: Bearer $LSY_INGEST_TOKEN_KAOROU" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"kaorou.job.failed","key":"job-91-attempt-3","subject":"job 91","title":"burn failed: ffmpeg exit 255","text":"stderr tail"}'
```

The event service listens on `127.0.0.1:3081`. Once a subscription matches, the request above answers `202` with `{"outcome":"accepted"}`. The body is one JSON object, one event per request, and only these fields are accepted:

| Field | Required | Rule |
|---|---|---|
| `kind` | yes | Dotted lowercase words that start with `<source>.`, for example `kaorou.job.failed`; at most 100 characters |
| `key` | yes | Dedupe key, unique within the source; 1-200 characters |
| `subject` | yes | What the event is about; 1-200 characters |
| `title` | yes | One-line label; 1-300 characters |
| `text` | no | Detail the model reads as untrusted data; at most 8000 characters |
| `url` | no | An `http` or `https` link; at most 2000 characters |
| `occurredAt` | no | When it happened, as epoch milliseconds |

`key`, `subject`, and `title` have their whitespace collapsed to single spaces. Any other field is refused, including `source` and `actor`: the token alone sets the source, and a pushed event carries no actor.

### Replies

| Status | Body | Meaning |
|---|---|---|
| 202 | `{ "outcome": "accepted" }` | Queued for at least one subscription |
| 202 | `{ "outcome": "duplicate" }` | The bus already holds this `source` and `key` |
| 202 | `{ "outcome": "suppressed" }` | A bus suppression marker matched the title or text |
| 202 | `{ "outcome": "unmatched" }` | Stored, but no subscription matches the event |
| 400 | `{ "error": "…" }` | Body is not UTF-8 or JSON, or a field breaks its rule; the message names the field |
| 401 | `{ "error": "…" }` | No bearer token, or a token no source owns |
| 405 | `{ "error": "…" }` | Method is not `POST`; the `Allow` header says so |
| 413 | `{ "error": "…" }` | Body is larger than `maxBodyBytes` |
| 415 | `{ "error": "…" }` | Content type is not `application/json` |
| 503 | `{ "error": "…" }` | No source has a token, or the bus failed |

`key` is the idempotency key. A service that retries a push with the same `key` never doubles an event, and a failure that can recur needs a new `key` per occurrence, such as `job-91-attempt-3`. The bus remembers the last `retainEvents` events (5000 by default), `unmatched` ones included, so a pushed key that nothing matched yet stays `duplicate` after a subscription is added.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

At mount time `apply` checks the configuration and throws on a path outside `/hooks/`, a malformed or repeated source id, or a reserved one (`github` and `schedule`). It then registers one exact route on `ctx.webServer`. For each request the handler checks, in order, the method, the `Authorization: Bearer` header, the token, the content type, the body, and the event fields, so a caller without a valid token learns nothing about the payload rules.

The token check resolves every source's token from the credential store, skips unset ones, and compares SHA-256 digests of the given and stored values with `timingSafeEqual`, so neither length nor content shows in timing. The matching source becomes the event's `source`. `eventFrom` in `src/event.ts` then validates the body against `LIMITS` and builds a `LsyEventInput`, requiring `kind` to start with `<source>.`; `ctx.lsyEventBus.publish()` returns the outcome that goes back as `202`. Any unexpected failure answers `503 ingest unavailable`. Logs name the source, kind, key, and outcome, and warn about a rejected push without the token; they never carry event text.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration checks, the route, token matching, body reading, replies |
| [`src/event.ts`](src/event.ts) | Field limits and the body-to-event validation |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md). Tests serve the route over a real HTTP server with fake `webServer`, `credentials`, and `lsyEventBus` services.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Event bus](../lsy-event-bus/README.md) — dedupe, subscriptions, coalescing, rate limits, and the Session prompt
- [GitHub sensor](../lsy-github-sensor/README.md) — the other source of events
- [Web server](../../host/webserver/README.md) — the route registry this package registers on
- [Credentials](../../credentials/credentials/README.md) — where the tokens are resolved from

-----

<a id="model-experience"></a>
## Model Experience

### Event data in Session prompts

#### What the model sees

This package adds no prompt or tool of its own. A pushed event reaches a model only through a `session` subscription of `@deepseek-ai/dsh-lsy-event-bus`, as an entry of `events_json` with `id` (`<source>:<key>`), `source`, `kind`, `subject`, `title`, `url`, `occurredAt`, and `text` (cut to the subscription's `maxTextChars`). A pushed event has no `actor`. The bus labels the list as untrusted data, and the subscription's own `instructions` frame the task.

#### Token effect

Up to 8000 characters of `text` per event, cut again to the subscription's `maxTextChars` (2000 by default), and at most `maxPromptEvents` events (50 by default) in one prompt.

#### KV Cache effect

Pushes never touch an existing Session: each batch opens a new Session, which establishes rather than invalidates a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A token is the whole credential** — there is no body signature, and replays are limited only by `key` dedupe; keep the route on loopback or the tailnet and rotate a token by changing it in the credential store and in the service, then restarting the host.
- **No limit on the route itself** — a token holder can push many distinct keys; the bus bounds what reaches the model through dedupe, coalescing, and `maxPerHour`, not by refusing requests.
- **One event per request** — a service that has ten events sends ten pushes.
- **Distinct tokens only** — if two sources share a token value, the later source in the list wins.
- **No actor on pushed events** — the bus cannot tell a push caused by the agent's own action from any other, so a service that reacts to the agent's work needs a suppression marker in its title or text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Whether a source may name an `actor`, so the bus's identity suppression could apply to pushed events, is undecided.

</details>
