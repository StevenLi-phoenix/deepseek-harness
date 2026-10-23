---
description: "Account settings card listing the balance or quota of every provider key the Host holds (OpenRouter, the DeepSeek API, OpenCode Go), under the DeepSeek account card; keys never leave the Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

English | [中文](README.zh.md)

## Summary

See what every model route has left on the page where the DeepSeek account balance already lives. Under the account card in **Settings → Account and balance**, one card lists each provider key the Host holds: what an OpenRouter key has left under its limit, a DeepSeek API key's wallets, and OpenCode Go's quota windows as bars. A route with nothing left turns red; one that could not be read says why. The card reads when the page opens and on Refresh.

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

Mount the row next to the Web bundles; the lsy event bundle mounts it. It needs the Account settings page (`@deepseek-ai/dsh-client-ui-settings-account`, which declares the `settings.account.balances` area) and, on the Host, the `account` Remote and the `credentials` and `connection` services, all of which the Web bundles compose.

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | OpenRouter (`OPENROUTER_API_KEY`), DeepSeek API (`DEEPSEEK_API_KEY`), OpenCode Go (`OPENCODE_GO_API_KEY`) | Keys to read: `kind` (`openrouter`, `deepseek`, `opencode-go`), `keyRef` (the credential reference, the Models page's `apiKeyEnv`), and `label`. A source whose key is unset is skipped |
| `cacheMs` | `60000` | How long the Host serves an answer from cache; Refresh bypasses it at most every 10 s |
| `timeoutMs` | `15000` | Deadline of one provider request |

Amounts follow the Account page: two decimals rounded down, `<¥0.01` below one cent. A DeepSeek API key that reports the same funded amounts as the signed-in account is left out, since the account card above already shows them. With no key configured the card does not render.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/lsy.balance` on the connection, so the `/api` sign-in check guards it. For each configured source it resolves the key through `credentials.resolve()`, sends it only to that provider's endpoint (`openrouter.ai/api/v1/key`, `api.deepseek.com/user/balance`, `opencode.ai/inference/go/v1/usage`), and answers readings without the key; failures are fixed phrases such as `HTTP 401`, never a response body. Answers are cached for `cacheMs` and shared while in flight; a missing key is logged once.

The browser half registers one entry (`lsy-provider-balances`) in the Account page's `settings.account.balances` area through `ctx.slots.inject`, so it follows that declaration's lifetime. One store and one `BalanceLoader` serve it. Each round fetches the document-relative `api/lsy.balance` (`?fresh=1` for Refresh) and calls `account.getBalance` with the Account page's client identity, only to recognize a DeepSeek API key of the same account; a round in flight is shared, and opening the page accepts a reading up to 30 seconds old. A failed route keeps the last readings.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: configuration, the cached `/api/lsy.balance` route |
| [`src/sources.ts`](src/sources.ts) | Per-provider queries and response parsing |
| [`src/readings.ts`](src/readings.ts) | Reading types and the route path, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader, the Account page registration |
| [`src/client/balance.ts`](src/client/balance.ts) | Wallet summary, amount formatting, store factory, loader |
| [`src/client/rows.ts`](src/client/rows.ts) | Card rows and the freshness line from the store state |
| [`src/client/ProviderBalances.tsx`](src/client/ProviderBalances.tsx) | The card |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Account settings](../../client/ui-settings-account/README.md) — the page and the `settings.account.balances` area this card fills
- [Platform account provider](../../credentials/deepseek-account-platform/README.md) — where the Host reads the account's wallets

-----

<a id="model-experience"></a>
## Model Experience

None, as the card is browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **OpenRouter shows the key, not the account** — `/api/v1/key` reports what is left under the key's own limit; a key without a limit shows what it has used, since the account's credit needs a management key.
- **Three providers** — other keys on the Models page have no reading until `sources.ts` learns their endpoint.
- **Read on demand** — the card reads when the page opens and on Refresh, with up to a minute of Host cache.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- An earlier version was a composer dock pill; the owner moved it to the Account page, where balances belong.

</details>
