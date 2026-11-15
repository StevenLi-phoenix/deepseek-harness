---
description: "event 服务的内容防线层：ctx.contentGuard，别人能读到的文本的唯一校验器，以及它拒绝记录的设置页。"
kind: "package-bundle"
---

# @deepseek-ai/guard

[English](README.md) | 中文

## 概述

这一层挂载 `ctx.contentGuard`：别人能读到的文本的唯一校验器，以及它拒绝记录的设置页。它的各层按顺序拒绝：模式、蜜标、与 owner 记忆文件的重叠、默认路由上的模型。每个写公开文本的地方都调它，它失败即拒绝。

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
| `content-guard` | `@deepseek-ai/dsh-content-guard` | `ctx.contentGuard` 和它的各层 |
| `content-guard-settings` | `@deepseek-ai/dsh-content-guard/settings` | 防线卡片：配置和最近 24 小时按规则统计 |

### 它依赖什么

重叠那一层要 owner 的记忆文件；最后一层要一条模型路由，面向公开受众时它不会被关掉。

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

- [内容防线包](../../../packages/fork/content-guard/README.zh.md)
- [说话风格](../style/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 它看的是文字不是意图，也可能把无害的话拒掉。
- 设置页只显示按规则的计数，从不显示文本。
