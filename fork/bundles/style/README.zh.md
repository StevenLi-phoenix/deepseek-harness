---
description: "event 服务的说话风格层：人格卡、特征、梗、语气样本，以及设置 → 说话风格。"
kind: "package-bundle"
---

# @deepseek-ai/style

[English](README.md) | 中文

## 概述

这一层挂载 DSH 的说话风格：用 `persona_update` 写的人格卡、用 `style_note` 写的群体语气特征和梗、一个梗挖掘器、`meme_lookup` 背后的 HotWatch 梗域，以及从记录的 QQ 群和公开 B 站评论里收的语气样本。每次公开写入都过 `ctx.contentGuard`，没挂载时直接拒绝；页面上的每一样 owner 都能改或删。

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
| `speaking-style` | `@deepseek-ai/dsh-speaking-style` | 风格存储、挖掘器，以及 `meme_lookup` 的索引 |
| `speaking-style-settings` | `@deepseek-ai/dsh-speaking-style-settings` | 设置 → 说话风格：人格卡、特征、梗、语气样本 |

### 它依赖什么

每次公开写入要 `ctx.contentGuard`；它挖掘的 QQ 或 B 站读取（那些功能没挂之前是空的）。

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

- [说话风格包](../../../packages/fork/speaking-style/README.zh.md)
- [内容防线](../guard/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 输入只有 QQ、B 站和公开网页：绝不包含 owner 记忆、微信或 owner 的消息。
- `review: required` 会把新语气样本扣着，等 owner 保留。
