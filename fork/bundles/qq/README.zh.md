---
description: "event 服务的 QQ 观察者层：qq-recorder 的 ctx.qq 客户端、设置 → QQ，以及 qq-digest 和 qq-main 两个预置。"
kind: "package-bundle"
---

# @deepseek-ai/qq

[English](README.md) | 中文

## 概述

这一层挂载 QQ 观察者：作为 qq-recorder 客户端的 `ctx.qq`（那条唯一的 OneBot 连接在记录器手里）、带登录二维码的设置 → QQ，以及读它记录的两种预置。`qq-digest` 在该群自己的 Session 里写这个群的摘要；`qq-main` 横跨各群保持全局印象。agent 从不在 QQ 上说话，也没有发送的工具。

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
| `qq` | `@deepseek-ai/dsh-qq` | 观察者客户端：群、摘要、笔记，以及向记录器推送设置 |
| `qq-login` | `@deepseek-ai/dsh-qq-login` | 设置 → QQ：连接、登录状态、登录二维码 |
| `preset-qq-digest` | `@deepseek-ai/dsh-agent-preset` | `qq-digest` 预置：一个群，两个窄写入工具 |
| `preset-qq-main` | `@deepseek-ai/dsh-agent-preset` | `qq-main` 预置：横跨各群的全局印象，没有工具 |

### 它依赖什么

同一台 Mac 上的 qq-recorder 服务（它的 socket 和 `QQ_RECORDER_TOKEN`）、`qq-main` 订阅里的 `qq` source，以及 `preset-unattended` 里的 `tool-qq` 行。

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

- [QQ 包](../../../packages/fork/qq/README.zh.md)
- [QQ 工具](../../../packages/fork/tool-qq/README.zh.md)
- [QQ 登录页](../../../packages/fork/qq-login/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- `groups` 初始为空：owner 在 profile patch 里列出群号之前什么都不记录。
- 不提供发送和语音转写；把它们打开会让加载失败。
