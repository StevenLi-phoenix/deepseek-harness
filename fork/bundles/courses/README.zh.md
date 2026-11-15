---
description: "event 服务的课程记录层：ctx.courses、按固定规则提醒的 DDL 轮询，以及设置 → 课程 DDL。"
kind: "package-bundle"
---

# @deepseek-ai/courses

[English](README.md) | 中文

## 概述

这一层挂载 owner 的课程记录和 DDL 轮询。每条提醒都由固定规则决定，从不用模型：每个 DDL 前有检查点，错过的 DDL 在补交窗口开着时立刻说一次，已交或已完成的任务跳过，每个任务和检查点只发一条，owner 睡着时不打扰，三小时内算紧急。同步坏了说一次，之后最多每天一次，恢复时说一次。

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
| `courses` | `@deepseek-ai/dsh-courses` | 课程记录客户端和 DDL 轮询 |
| `courses-settings` | `@deepseek-ai/dsh-courses-settings` | 设置 → 课程 DDL：检查项和这一行的 config |

### 它依赖什么

课程服务和 `$DSH_HOME/.env` 里的 `COURSES_PAT`、算免打扰要的 `ctx.presence`，以及 `preset-unattended` 里的 `tool-courses` 行。

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

- [课程包](../../../packages/fork/courses/README.zh.md)
- [课程工具](../../../packages/fork/tool-courses/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- DSH 只读记录的同步健康度；同步 agent 在别处跑。
- 手改的 DDL 不算事实：记录显示的是同步最后一次读到的内容。
