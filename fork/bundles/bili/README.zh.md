---
description: "event 服务的 B 站账号层：作为 bili-svc 客户端的 ctx.bili，以及在那里回话的 bili 和 up 两个预置。"
kind: "package-bundle"
---

# @deepseek-ai/bili

[English](README.md) | 中文

## 概述

这一层挂载 agent 自己的 B 站账号，以及作用在它上面的两个预置。`ctx.bili` 是 bili-svc 的客户端，会话由 bili-svc 保管，所有写操作走同一份账本、每日额度和刹车；`bili` 回 owner 本人的私信并发每日推荐，`up` 在同一道回复闸门后面回观众。两个预置都没有 shell、文件或网页工具。

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
| `bili` | `@deepseek-ai/dsh-bili` | 账号作为 bili-svc 客户端、它的日记和设置页 |
| `preset-bili` | `@deepseek-ai/dsh-agent-preset` | `bili` 预置：读取和不发言的操作，没有发言的路径 |
| `preset-up` | `@deepseek-ai/dsh-agent-preset` | `up` 预置：读取和两个回复工具，都在闸门后面 |

### 它依赖什么

`bili-dm` 频道要的 `owner-relay`、`ctx.ownerNotifier` 要的 `wechat`，以及点名 `bili` 和 `up` 预置的总线订阅。bili-svc 要在同一台 Mac 上跑，并有这个账号的会话。

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

- [B 站账号包](../../../packages/fork/bili/README.zh.md)
- [UP 主工具](../../../packages/fork/tool-up/README.zh.md)
- [B 站工具](../../../packages/fork/tool-bili/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 没有 bili-svc 或 `BILI_SVC_TOKEN_BILI` 时每次读取和操作都带着原因失败；不会直连 B 站兜底。
- 这个账号从不评论、发动态，也不给 owner 以外的人发私信；回观众属于 `up` 和闸门的事。
