---
description: "event 服务的 Gmail 账号层：带每账号发送策略的 ctx.gmail、草稿、附件和标签改动，以及设置 → 邮箱。"
kind: "package-bundle"
---

# @deepseek-ai/gmail

[English](README.md) | 中文

## 概述

这一层挂载 owner 的 Gmail 账号：每个账号一次只带 `gmail.modify` 的 Google 登录、Gmail REST API、每账号的发送策略、草稿、附件和标签改动，以及设置 → 邮箱（OAuth 客户端和扣下的消息）。读邮件算读了陌生人的字，所以之后的发送要等 owner 确认。

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
| `gmail` | `@deepseek-ai/dsh-gmail` | 账号、发送闸门、草稿和标签 |
| `gmail-settings` | `@deepseek-ai/dsh-gmail-settings` | 设置 → 邮箱：OAuth 客户端、连接、扣下的消息 |

### 它依赖什么

`GMAIL_CLIENT_ID` 和凭据库里的每账号授权，以及 `preset-unattended` 里的 `tool-gmail` 行。

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

- [Gmail 包](../../../packages/fork/gmail/README.zh.md)
- [Gmail 工具](../../../packages/fork/tool-gmail/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 只申请 `gmail.modify` 权限；其它 Google 服务都够不到。
- 每个账号 24 小时最多 50 封，改过的草稿绝不发。
