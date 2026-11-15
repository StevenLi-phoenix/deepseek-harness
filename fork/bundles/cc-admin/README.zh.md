---
description: "event 服务的 Claude Code 页层：ctx.claudeCodeSessions，在控制台列出、启动、停止服务账号的会话。"
kind: "package-bundle"
---

# @deepseek-ai/cc-admin

[English](README.md) | 中文

## 概述

这一层挂载 `ctx.claudeCodeSessions`：控制台页面用它列出、启动、停止服务账号的 Claude Code 会话。它走 root，是因为 `cc-bridge` 的工具在 `unattended` 预置的挂载里，外面碰不到；默认值沿用 bridge 自己的。

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
| `cc-admin` | `@deepseek-ai/dsh-cc-admin` | 给设置 → 服务总览用的 `ctx.claudeCodeSessions` |

### 它依赖什么

读它的控制台页面，以及 `preset-unattended` 里给 agent 用的 `cc-bridge`。

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

- [Claude Code 管理页包](../../../packages/fork/cc-admin/README.zh.md)
- [Claude Code bridge 包](../../../packages/fork/cc-bridge/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 页面只显示服务账号自己的会话；它不接入会话，也不读对话记录。
