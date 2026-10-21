---
description: "Telegram Bot API notifier for the lsy event bus: sends event batches and agent Session results to one chat as plain text, with the bot token read from a credential reference."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-telegram

English | [中文](README.zh.md)

## Summary

Get event-bus batches and unattended agent answers on your phone through a Telegram bot. Messages are plain text, so untrusted event text cannot inject markup or links that look like yours. The bot token is resolved per send from a credential reference, so rotating it needs no restart. A short Telegram rate limit is retried once; anything else fails loudly to the bus, which records it on the batch.

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

Create a bot with @BotFather, send it one message, read your chat id from `getUpdates`, store the token as `LSY_TELEGRAM_BOT_TOKEN` in the instance's credential store or `$DSH_HOME/.env`, and mount the notifier next to the bus.

### When to choose it

Choose it when Telegram is where you want to be interrupted. Any other channel can provide `ctx.lsyNotifier` instead; the bus only needs `send(note)`.

### Minimal configuration

```yaml
- insert:
    - id: lsy-telegram
      name: '@deepseek-ai/dsh-lsy-telegram'
      config:
        chatId: '123456789'
```

| Field | Default | Meaning |
|---|---|---|
| `chatId` | required | User id, group id (negative), or `@channelname` |
| `botTokenEnv` | `LSY_TELEGRAM_BOT_TOKEN` | Credential reference holding the bot token |
| `apiBase` | `https://api.telegram.org` | Bot API origin |
| `timeoutMs` | `15000` | Per-request deadline |
| `maxRetryAfterSeconds` | `30` | Longest `retry_after` honored with one retry |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidshlsy-telegram) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service registers as `ctx.lsyNotifier`. Each `send()` resolves the token, renders title, body, and link separated by blank lines, clips the text to 4096 characters, and calls `sendMessage` with link previews disabled. Errors carry the HTTP status and Telegram's description, never the request URL that contains the token.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, rendering, and the Bot API call |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [lsy event bus](../lsy-event-bus/README.md) — the consumer of `ctx.lsyNotifier`
- [Credentials](../../credentials/credentials/README.md) — credential references and resolution order

-----

<a id="model-experience"></a>
## Model Experience

None, as the notifier sends messages to a human and adds nothing to any model request.

#### KV Cache effect

Independent: no model request is touched.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **One chat** — every note goes to the configured chat; per-subscription routing is deferred.
- **No inline approval** — messages are one-way; approvals still happen in the Web UI.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>
