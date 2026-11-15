---
description: "Profile layer for the event service's WeChat channel: the owner's chat Session, ctx.ownerNotifier, and the browser half of Settings → WeChat."
kind: "package-bundle"
---

# @deepseek-ai/wechat

English | [中文](README.zh.md)

## Summary

This layer mounts the owner's channel: a chat Session over WeChat, `ctx.ownerNotifier` for the bus, and the browser half of Settings → WeChat. The chat works in a clone of the owner's tracking repository, and the relay's `wechat` channel carries each turn's answer back. Defaults here are deployment values: the workspace path, the 300 s media timeout, and hybrid delivery.

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
| `wechat-settings` | `@deepseek-ai/dsh-wechat-settings` | the browser pages of Settings → WeChat and Settings → 勿扰 |
| `wechat` | `@deepseek-ai/dsh-wechat` | the WeChat chat Session, `ctx.ownerNotifier`, and the `wechat` relay channel |

### What it needs

`owner-relay`, which the channel claims, and `presence`, which decides whether a note waits for the morning. The bot account is bound once and kept in `$DSH_HOME/wechat/account.json`.

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

- [WeChat package](../../../packages/fork/wechat/README.md)
- [Owner relay package](../../../packages/fork/owner-relay/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Without `$DSH_HOME/wechat/account.json` the channel idles and queues notifications.
- The reply window is WeChat's: a send works only while the owner's last message is recent.
