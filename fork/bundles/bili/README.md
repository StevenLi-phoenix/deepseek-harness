---
description: "Profile layer for the event service's Bilibili account: the ctx.bili client of bili-svc and the bili and up presets that answer there."
kind: "package-bundle"
---

# @deepseek-ai/bili

English | [中文](README.zh.md)

## Summary

This layer mounts the agent's own Bilibili account and the two presets that act on it. `ctx.bili` is a client of bili-svc, which holds the session and does every write under one ledger, daily caps and a brake; `bili` answers the owner's own messages and sends the daily share, and `up` answers viewers behind the same Reply Gate. Neither preset has a shell, file, or web tool.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into the event profile

The layer ships with this repository: `fork/deploy/setup-profile.sh` links every directory under `fork/bundles/` into `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/` and writes the profile manifest, so a deploy mounts it without a per-deployment edit. To add it by hand, link it and name it at the end of `dsh.profile.bundles`.

### What you get

| Row | Package | What it mounts |
|---|---|---|
| `bili` | `@deepseek-ai/dsh-bili` | the account as a bili-svc client, its journal and its Settings section |
| `preset-bili` | `@deepseek-ai/dsh-agent-preset` | the `bili` preset: reads and non-speech actions, no way to speak |
| `preset-up` | `@deepseek-ai/dsh-agent-preset` | the `up` preset: reads and the two reply tools, behind the Gate |

### What it needs

`owner-relay` for the `bili-dm` channel, `wechat` for `ctx.ownerNotifier`, and the bus subscriptions that name the `bili` and `up` presets. bili-svc must run on the same Mac with a session for the account.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The rows are the ones this feature had inside `@deepseek-ai/dsh-event-bundle`, moved here verbatim and in the same relative order. The profile applies every layer as one flattened patch list in `dsh.profile.bundles` order, and an `insert` appends, so this layer mounts after the skeleton rows it uses and before the owner's profile patch. `fork/bundles/event/README.md` holds the mount order and the reasoning.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bilibili account package](../../../packages/fork/bili/README.md)
- [Creator-account tools](../../../packages/fork/tool-up/README.md)
- [Bilibili tools](../../../packages/fork/tool-bili/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Without bili-svc or `BILI_SVC_TOKEN_BILI` every read and action fails with the reason; nothing falls back to Bilibili directly.
- The account never comments, posts or messages anyone but the owner; replies to viewers belong to `up` and the Gate.
