---
description: "event 服务的输入框停靠区胶囊：DeepSeek 账户余额，排在活动和用量胶囊旁边。"
kind: "package-bundle"
---

# @deepseek-ai/provider-balance

[English](README.md) | 中文

## 概述

这一层只加一个输入框停靠区胶囊：DeepSeek 账户余额，排在活动和用量胶囊旁边。它是一行 UI，没有工具，也不影响 Session 行为。

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
| `provider-balance` | `@deepseek-ai/dsh-provider-balance` | 输入框停靠区里的余额胶囊 |

### 它依赖什么

profile 里要有 DeepSeek 的 provider 路由；没有时胶囊没有可显示的数。

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

- [余额胶囊包](../../../packages/fork/provider-balance/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 胶囊只读配置好的那条 DeepSeek 路由的余额。
