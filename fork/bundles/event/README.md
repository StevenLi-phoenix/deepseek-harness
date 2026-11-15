---
description: "The event service skeleton as a profile layer: logging, webhook runtime, owner relay, event bus and subscriptions, ingest, the console and settings rows, and the presets the service runs on. Every feature is a bundle of its own mounted right after it."
kind: "package-bundle"
---

# @deepseek-ai/dsh-event-bundle

English | [中文](README.zh.md)

## Summary

This is the event profile's skeleton layer. It mounts what every deployment of the event-driven agent service needs before any feature: the logger, the webhook runtime that creates bus Sessions, the owner relay, the event bus with its subscriptions, the push ingest route, the All settings card, the service console, and the `notify` and `unattended` presets. Each feature then arrives as its own bundle, listed after this one in `fork/profiles/event/package.json`. Drop a feature bundle and the service still composes; drop this layer and nothing else has a bus to publish to.

## Table of Contents

- [Use this package](#use-this-package)
- [The layers and their order](#the-layers-and-their-order)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into the event profile

`fork/deploy/setup-profile.sh` links every directory under `fork/bundles/` into `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/` and writes the profile manifest, which names the layers in mount order. To compose the profile by hand, link a layer and name it in `dsh.profile.bundles`:

```yaml
- insert:
    - id: event-bus
      name: '@deepseek-ai/dsh-event-bus'
```

### What the skeleton mounts

| Row | Package | What it mounts |
|---|---|---|
| `logger-console` | `@deepseek-ai/cordis-plugin-logger-console` | stdout logging at info, with the Bilibili account and owner relay at debug |
| `webhook-runtime` | `@deepseek-ai/dsh-webhook` | the Session creation seam the bus uses for `session` subscriptions |
| `owner-relay` | `@deepseek-ai/dsh-owner-relay` | one rule set at each turn end, handing the answer to the channel that claimed the Session |
| `time-gap` | `@deepseek-ai/dsh-time-gap` | the silence notice in front of a turn that starts after five quiet minutes |
| `event-bus` | `@deepseek-ai/dsh-event-bus` | routing: every subscription, its coalescing, its caps, and the Session each one starts |
| `event-ingest` | `@deepseek-ai/dsh-event-ingest` | the push route `POST /hooks/events`, one token per source |
| `plugin-config` | `@deepseek-ai/dsh-plugin-config` | the All settings card on every Settings page |
| `event-console` | `@deepseek-ai/dsh-event-console` | Settings → Service overview, Subscriptions and monitors, Claude Code and voice |
| `preset-notify` | `@deepseek-ai/dsh-agent-preset` | the `notify` preset of the notification desk, which filters and sums up for the main agent |
| `preset-unattended` | `@deepseek-ai/dsh-agent-preset` | the `unattended` preset: the WeChat chat Session and every Session a watch, reminder or event starts |

Nine rows above the insert list override rows the base and Web bundles mount: they keep this instance remote-first, count channel-bot Sessions as automated, move the root `working_directory` tool into the `unattended` preset, keep read-before-write and the DeepSeek search provider, and keep Agent Teams out.

<a id="the-layers-and-their-order"></a>
## The layers and their order

The profile applies every layer's patch as one flattened list in the order `dsh.profile.bundles` names them, and an `insert` appends. A feature bundle's rows therefore land after the skeleton's, which is the direction every dependency needs: they may use the bus, the relay, the ingest sources and the presets the skeleton mounts. The table is the mount order `fork/profiles/event/package.json` writes.

| Layer | What it adds | Depends on |
|---|---|---|
| `@deepseek-ai/dsh-event-bundle` | the skeleton above | — |
| `@deepseek-ai/github` | GitHub App route, sensor | the bus it publishes to |
| `@deepseek-ai/headless-browser` | one persistent Chromium | — |
| `@deepseek-ai/provider-balance` | composer dock pill | — |
| `@deepseek-ai/subagent-activity` | the 子智能体 panel | shadows `ui-subagent` by slot priority |
| `@deepseek-ai/sysmon` | Settings → System status | — |
| `@deepseek-ai/memory` | Settings → Memory page and route | the memory file the `owner-memory` row writes |
| `@deepseek-ai/presence` | sleep state, Settings → 勿扰 | every notifier reads `ctx.presence` |
| `@deepseek-ai/wechat` | WeChat channel, Settings → WeChat | owner-relay channel `wechat` |
| `@deepseek-ai/cc-admin` | `ctx.claudeCodeSessions` for the console | the console page that reads it |
| `@deepseek-ai/voice` | `ctx.voice` | the `speak` tool in the unattended preset |
| `@deepseek-ai/bili` | Bilibili account, presets `bili` and `up` | owner-relay channel `bili-dm`, the bus subscriptions that name the presets |
| `@deepseek-ai/qq` | QQ observer, Settings → QQ, presets `qq-digest` and `qq-main` | the `qq-main` subscription and the `tool-qq` row |
| `@deepseek-ai/courses` | course records and the deadline poller | `ctx.presence` for quiet hours |
| `@deepseek-ai/gmail` | Gmail accounts, Settings → 邮箱 | the `tool-gmail` row |
| `@deepseek-ai/qqbot` | official QQ bot channel, preset `qqbot` | owner-relay channel `qqbot` |
| `@deepseek-ai/integrity` | integrity watch | — |
| `@deepseek-ai/guard` | `ctx.contentGuard`, Settings view | every writer of public text |
| `@deepseek-ai/style` | speaking style, Settings → 说话风格 | `ctx.contentGuard`, the QQ and Bilibili reads it mines |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each feature bundle's `cordis.patch.yml` holds the rows this file used to hold, verbatim and in the same relative order; `fork/bundles/event/cordis.patch.yml` keeps the skeleton rows and the root overrides. A test compares the composed layers with the old single-file composition, so a row cannot be lost or changed silently.

A preset stays whole in one layer. An agent preset's plugins are a config value (`config.plugins`), not a group the patch engine indexes, so a later layer cannot insert into a preset: the feature presets (`bili`, `up`, `qqbot`, `qq-digest`, `qq-main`) travel with their feature, and the two service-wide ones (`notify`, `unattended`) stay here.

The `unattended` preset names the tools of several features (`tool-qq`, `tool-courses`, `tool-gmail`, `tool-voice`, `cc-bridge`, `tool-monitor`). Those rows stay in the skeleton with the preset, because they cannot be patched into it from another layer. Dropping a feature bundle therefore means dropping its tool row from `preset-unattended` as well.

The bus keeps every subscription. Routing is the service's, not a feature's: a subscription names the preset or the source it needs, and a feature that is not mounted simply never triggers its own subscription.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [GitHub sensor](../github/README.md)
- [WeChat channel](../wechat/README.md)
- [Bilibili account](../bili/README.md)
- [Profile and deploy scripts](../../README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- A feature bundle cannot be dropped without editing `preset-unattended` when that feature owns a tool row there.
- Subscription changes are made in `@deepseek-ai/dsh-event-bundle`, not in the feature bundle whose events they route.
