---
description: "event 服务的完整性监视层：凡是会左右 agent 的东西的摘要，以及每个 Session 系统提示的哈希。"
kind: "package-bundle"
---

# @deepseek-ai/integrity

[English](README.md) | 中文

## 概述

这一层挂载完整性监视：会左右 agent 的东西的摘要（两份 profile patch、各工作区的指令文件和技能目录、记忆文件与其历史、定时任务），以及每个 Session 系统提示的哈希，还有人格被禁套话的每日计数。有变化只进日志；这里关掉了微信通知。

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
| `integrity-watch` | `@deepseek-ai/dsh-integrity-watch` | 摘要、提示哈希和套话计数 |

### 它依赖什么

不依赖别的功能：它读的是 Host 本来就挂载的文件。

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

- [完整性监视包](../../../packages/fork/integrity-watch/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 这里 `notify: false`：变化只记日志，不发消息。
- 它记录的是"有东西变了"，不是谁改的、改了什么。
