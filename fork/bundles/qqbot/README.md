---
description: "Profile layer for the event service's official QQ bot channel: ctx.qqBot, its allow-lists, and the qqbot preset."
kind: "package-bundle"
---

# @deepseek-ai/qqbot

English | [中文](README.zh.md)

## Summary

This layer mounts the official QQ bot channel, disabled by default. When enabled it answers owner-listed openids in private chats and where the bot is mentioned, one chat Session each, through the relay's `qqbot` channel, with the `qqbot` preset. It is not the QQ observer and does not need it.

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
| `qqbot` | `@deepseek-ai/dsh-qqbot` | the bot channel, disabled until the owner enables it |
| `preset-qqbot` | `@deepseek-ai/dsh-agent-preset` | the `qqbot` preset: persona, time, and speaking style |

### What it needs

`owner-relay` for the `qqbot` channel, `QQBOT_APP_ID` and `QQBOT_APP_SECRET` in `$DSH_HOME/.env` (or a bot created with the login script), and the owner's openids in the profile patch.

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

- [QQ bot package](../../../packages/fork/qqbot/README.md)
- [Owner relay package](../../../packages/fork/owner-relay/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `disabled: true` here: a deployment enables it and lists its openids in the profile patch.
- `allow` starts empty, so nobody is answered until listed.
