---
description: "event 服务的语音线路层：给 owner 的 iPhone 打电话的 ctx.voiceCall，以及通话 Session 的 voice-call 预置。"
kind: "package-bundle"
---

# @deepseek-ai/voice-call

[English](README.md) | 中文

## 概述

这一层挂载语音线路，默认关闭。打开后 agent 可以用 `call_owner` 给 owner 打电话，owner 也可以在 DSH Call app 里打给 agent；每通接起的电话是一条经 Tailscale 的 WebRTC 连接和一个用 `voice-call` 预置的通话 Session，它的回答由 relay 的 `voice-call` 频道在线路上念出来。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 装进 event profile

这一层随仓库发布：`fork/deploy/setup-profile.sh` 会把 `fork/bundles/` 下的每个目录链接进 `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/`，并写好 profile 清单，所以部署时不用逐台改动。手动加入就自己建链接，把名字加到 `dsh.profile.bundles` 末尾。

### 这一层挂载什么

| 行 | 包 | 挂载什么 |
|---|---|---|
| `voice-call` | `@deepseek-ai/dsh-voice-call` | 语音线路，owner 打开之前不挂 |
| `preset-voice-call` | `@deepseek-ai/dsh-agent-preset` | `voice-call` 预置：口语人格、时间、压缩 |

event bundle 的 `unattended` 预置挂载 `call_owner`（`@deepseek-ai/dsh-tool-voice-call`）；只有语音线路在跑时这个工具才出现。

### 它依赖什么

`voice-call` 频道要的 `owner-relay`；`$DSH_HOME/.env` 里的 `VOICE_CALL_TOKEN` 和 APNs 密钥（`VOICE_CALL_APNS_KEY_ID`、`VOICE_CALL_APNS_TEAM_ID`、`VOICE_CALL_APNS_KEY`）；profile patch 里 app 的 bundle identifier；以及装在 owner iPhone 上的 DSH Call app。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

profile 按 `dsh.profile.bundles` 的顺序把所有层拼成一个 patch 列表，`insert` 是追加，所以这一层挂在它用到的骨架行（`owner-relay`、`voice`、`presence`）之后、owner 的 profile patch 之前。挂载顺序和理由见 `fork/bundles/event/README.md`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [voice-call 包](../../../packages/fork/voice-call/README.zh.md)
- [call_owner 工具](../../../packages/fork/tool-voice-call/README.zh.md)
- [DSH Call iOS app](../../apps/voice-call-ios/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 这里是 `disabled: true`：部署时在 profile patch 里打开，并填上 app 的 bundle identifier。
- 通话 Session 没有工具；通话里 owner 交代的事在挂断后交给主 agent。
