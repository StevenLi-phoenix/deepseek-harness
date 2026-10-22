---
description: "Composer dock pill that keeps the DeepSeek account balance in view next to the activity and usage readings, read through the same Host account Remote as the Account settings page."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

English | [中文](README.zh.md)

## Summary

See how much DeepSeek credit is left without opening Settings. The pill sits under the composer after the activity and usage readings and shows each currency's total, topped-up plus granted. Hovering it shows the split and when it was read. It turns red when nothing is left, dims a reading that a refresh could not renew, and refreshes when you click it, when the window regains focus, and every two minutes while the page is visible. It shows nothing while no DeepSeek account is signed in.

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

Mount the row next to the Web bundles; the lsy event bundle mounts it. The Host must serve the `account` Remote (`@deepseek-ai/dsh-api-account-controller` over a DeepSeek account provider), which the Web bundles already compose.

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

The plugin has no configuration. The amounts follow the Account settings page: two decimals rounded down, `<¥0.01` below one cent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers one `conversation.composer.dock` entry (`id: balance`, `order: 2`, after ui-chat's `activity` and `usage` pills) through `ctx.slots.inject`, so it follows the dock declaration's lifetime. One store and one `BalanceLoader` serve every open composer. The loader calls `account.getBalance` with the client identity the Account settings page sends, shares a request in flight, and skips a query when an answer settled within the caller's accepted age: two minutes for a mount or the timer, thirty seconds for a returning window, none for a click. A `null` answer means signed out and clears the wallets; a failed answer keeps the last good wallets and logs one generic console warning without any Host text. Amounts are decimal strings summed with `big.js`, so nothing passes through floating point.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader over the account Remote, the dock registration |
| [`src/client/balance.ts`](src/client/balance.ts) | Wallet summary, amount formatting, store factory, loader |
| [`src/client/BalancePill.tsx`](src/client/BalancePill.tsx) | The pill, its tooltip, and its refresh triggers |
| [`src/index.ts`](src/index.ts) | Empty Host half that keeps the row on the Host roster |

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

- **Account balance only** — the pill reads the signed-in DeepSeek account; API-key providers, including the official DeepSeek key route and OpenRouter, are not shown.
- **Polling, not push** — spending shows up on the next refresh, at most two minutes later while the page is visible, or at once on click.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- A turn-end refresh would show spending sooner than the timer; it needs a Session event the dock entry can observe without reaching into ui-chat.

</details>
