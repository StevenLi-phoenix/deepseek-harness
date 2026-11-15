---
description: "event 服务的勿扰状态层：睡眠专注信号、免打扰时段，以及设置 → 勿扰。"
kind: "package-bundle"
---

# @deepseek-ai/presence

[English](README.md) | 中文

## 概述

这一层挂载 owner 的 presence：是否睡着（来自 helper 推给 ingest 的睡眠专注信号）、按部署时区的每日免打扰时段，以及设置 → 勿扰里的按钮。睡着时非紧急消息等着，醒来合成一条发；紧急类型照发。这里把时区定为 `America/New_York`。

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
| `presence` | `@deepseek-ai/dsh-presence` | 睡眠状态、免打扰时段、设置 → 勿扰 |

### 它依赖什么

骨架 `event-ingest` 里的 `presence` source 行，以及 `$DSH_HOME/.env` 中的 `EVENT_INGEST_TOKEN_PRESENCE`；helper 的 token 文件里是同一个值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

这里的行就是该功能原先写在 `@deepseek-ai/dsh-event-bundle` 里的那些，逐字搬过来，相对顺序不变。profile 按 `dsh.profile.bundles` 的顺序把各层合成一个扁平的 patch 列表来应用，`insert` 是追加，所以这一层挂载在它用到的骨架行之后、owner 的 profile patch 之前。挂载顺序和理由写在 `fork/bundles/event/README.md`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [presence 包](../../../packages/fork/presence/README.zh.md)
- [微信频道](../wechat/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 没有 helper 的推送时，状态退回以免打扰时段为准，两小时后过期。
- 时区是部署值：换一个 home 就在 profile patch 里重写 `timeZone`。
