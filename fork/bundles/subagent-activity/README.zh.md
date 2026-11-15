---
description: "event 服务的子智能体面板层：右侧栏 → 子智能体，每个子 agent 现在在做什么、跑了多久、怎么结束的。"
kind: "package-bundle"
---

# @deepseek-ai/subagent-activity

[English](README.md) | 中文

## 概述

这一层加上右侧栏 → 子智能体：一个 Session 的子 agent，各自现在在做什么、跑了多久、怎么结束的。它的表头按钮按 slot id 和优先级盖住 `ui-subagent` 的悬停目录；`ui-subagent` 仍负责面包屑切换和侧栏会话标签。Host 侧为子 agent Session 注册 `subagentActivity` 投影。

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
| `subagent-activity` | `@deepseek-ai/dsh-subagent-activity` | 子智能体面板和 `subagentActivity` 投影 |

### 它依赖什么

Web bundle 的 `ui-subagent`：这一面板只在一个 slot 上盖住它，别处仍然用它。

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

- [子智能体面板包](../../../packages/fork/subagent-activity/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 面板只列子 agent Session；root Session 自己的工作不显示。
