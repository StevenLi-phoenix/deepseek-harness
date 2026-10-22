---
description: "Composer dock pill that keeps every balance in view next to the activity and usage readings: the DeepSeek account, plus OpenRouter, DeepSeek API, and OpenCode Go keys read on the Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

English | [中文](README.zh.md)

## Summary

See what every model route has left without opening Settings or a provider console. Under the composer, after the activity and usage readings, the pill shows one labelled segment per source: `DeepSeek ¥12.34 · OpenRouter $7.50 · OpenCode Go 34%`. Hovering explains each segment and when it was read. A segment with nothing left turns red, an unreadable one dims, and the pill refreshes on click, on window focus, and every two minutes while the page is visible.

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

Mount the row next to the Web bundles; the lsy event bundle mounts it. The Host must serve the `account` Remote (`@deepseek-ai/dsh-api-account-controller` over a DeepSeek account provider) and the `credentials` and `connection` services, which the Web bundles already compose.

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | OpenRouter (`OPENROUTER_API_KEY`), DeepSeek API (`DEEPSEEK_API_KEY`), OpenCode Go (`OPENCODE_GO_API_KEY`) | Keys to read: `kind` (`openrouter`, `deepseek`, `opencode-go`), `keyRef` (the credential reference, the Models page's `apiKeyEnv`), and `label`. A source whose key is unset is skipped |
| `cacheMs` | `60000` | How long the Host serves an answer from cache; a click bypasses it at most every 10 s |
| `timeoutMs` | `15000` | Deadline of one provider request |

The DeepSeek account shows topped-up plus granted credit, an OpenRouter key what is left under its limit, a DeepSeek API key its wallets, and OpenCode Go its most-used quota window. Amounts follow the Account settings page: two decimals rounded down, `<¥0.01` below one cent. A DeepSeek API reading equal to the signed-in account's is not shown twice.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/lsy.balance` on the connection, so the `/api` sign-in check guards it. For each configured source it resolves the key through `credentials.resolve()`, sends it only to that provider's endpoint (`openrouter.ai/api/v1/key`, `api.deepseek.com/user/balance`, `opencode.ai/inference/go/v1/usage`), and answers readings without the key; failures are fixed phrases such as `HTTP 401`, never a response body. Answers are cached for `cacheMs` and shared while in flight; a missing key is logged once.

The browser half registers one `conversation.composer.dock` entry (`id: balance`, `order: 2`, after ui-chat's `activity` and `usage` pills) through `ctx.slots.inject`, so it follows the dock declaration's lifetime. One store and one `BalanceLoader` serve every open composer. Each round calls `account.getBalance` with the client identity the Account settings page sends and fetches the document-relative `api/lsy.balance` (`?fresh=1` for a click); it shares a round in flight and skips one when an answer settled within the caller's accepted age: two minutes for a mount or the timer, thirty seconds for a returning window, none for a click. A `null` account answer means signed out; a failed one keeps the last good wallets, and a failed route keeps the last readings. Account amounts are decimal strings summed with `big.js`, so nothing passes through floating point.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: configuration, the cached `/api/lsy.balance` route |
| [`src/sources.ts`](src/sources.ts) | Per-provider queries and response parsing |
| [`src/readings.ts`](src/readings.ts) | Reading types and the route path, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader over the account Remote and the route, the dock registration |
| [`src/client/balance.ts`](src/client/balance.ts) | Wallet summary, amount formatting, store factory, loader |
| [`src/client/segments.ts`](src/client/segments.ts) | Segments and tooltip lines from the store state |
| [`src/client/BalancePill.tsx`](src/client/BalancePill.tsx) | The pill and its refresh triggers |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Account settings](../../client/ui-settings-account/README.md) — the page whose balance query this pill shares
- [Platform account provider](../../credentials/deepseek-account-platform/README.md) — where the Host reads the wallets

-----

<a id="model-experience"></a>
## Model Experience

None, as the pill is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **OpenRouter shows the key, not the account** — `/api/v1/key` reports what is left under the key's own limit; a key without a limit shows what it has used, since the account's credit needs a management key.
- **Three providers** — other keys on the Models page have no reading until `sources.ts` learns their endpoint.
- **Polling, not push** — spending shows up on the next refresh, at most two minutes later while the page is visible (one minute of Host cache included), or at once on click.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A turn-end refresh would show spending sooner than the timer; it needs a Session event the dock entry can observe without reaching into ui-chat.

</details>
