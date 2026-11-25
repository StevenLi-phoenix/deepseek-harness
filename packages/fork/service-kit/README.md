---
description: "Host helpers the fork's long-running services and tools share: tracked background work and an abortable pause, the Sessions a channel opens and hands to the owner relay, a JSON Settings route's body and errors, one model call without a Session, and JSON tool output."
kind: "package-library"
---

# @deepseek-ai/dsh-service-kit

English | [中文](README.zh.md)

## Summary

The fork's channel services (Bilibili, WeChat, the QQ bot, the QQ observer), the event bus, and its tools do the same plumbing, so they share one copy of it. Background work is tracked and drained before storage closes, a retry pause ends early on demand, chat Sessions are opened with their presets and claimed by the owner relay, Settings routes read JSON actions the same way, and the content guard and the meme miner make their one model call through the same code.

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

Import it from Host code and list it beside the fork's other workspace dependencies. It is not a plugin and is never mounted. Its exports keep no module state and check no identity, so the dependency policy lists it as safe across duplicate installations, which lets `bili`, a package with a browser face, import it on the Host.

```ts
import { BackgroundWork, openPresetSession, pause, readJsonAction } from '@deepseek-ai/dsh-service-kit'

private readonly background = new BackgroundWork((error) => { this.ctx.logger.warn(`svc: background work failed: ${String(error)}`) })
// teardown: await this.background.drain()
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`BackgroundWork` keeps one chain of serialized storage writes (a rejection reaches its caller and the chain goes on), tracked work whose failure goes to the callback, and held work whose outcome stays the caller's; `drain()` waits for all of it. `pause(ms, signal, slot)` ends on its timer, on abort, or through `slot.wake`, which it clears unless a later pause took it. `unavailableReason` keeps a stored Session that resolves and throws while its agent is busy or its writer held; `openPresetSession` checks the permission preset before it creates anything; `forgetOldest` drops the oldest remembered Sessions; `joinRelay` claims the stored Sessions once storage is open and nothing after the channel left. `readJsonAction` answers 415 or 400 without repeating the body. `callModelOnce` runs at temperature 0 and, on an explicit route, at the lightest reasoning effort offered.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The exports |
| [`src/work.ts`](src/work.ts) | `BackgroundWork`, `pause` |
| [`src/chat-session.ts`](src/chat-session.ts) | `unavailableReason`, `openPresetSession`, `forgetOldest`, `joinRelay` |
| [`src/json-route.ts`](src/json-route.ts) | `readJsonAction`, `readJsonBody`, `jsonFailure`, `NO_STORE` |
| [`src/model-call.ts`](src/model-call.ts) | `callModelOnce` |
| [`src/tool-output.ts`](src/tool-output.ts) | `ERROR_SCHEMA`, `renderJson`, `renderWrapped` |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fork packages](../README.md) — the services and tools that import it

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the packages that call it: `callModelOnce` sends the content guard's and the meme miner's prompts, and the tool renderers shape what fork tools return.

#### KV Cache effect

None of its own; each caller's request is a single call without a Session, so no cached prefix is shared.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One model call at a time** — `callModelOnce` streams one request and keeps no conversation; a caller that needs a follow-up sends a new one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- `joinRelay` takes the relay structurally (`RelayRegistry`) because `owner-relay` depends on `event-bus`, which imports this package.

</details>
