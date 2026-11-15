---
description: "event 服务的微信频道层：owner 的聊天 Session、ctx.ownerNotifier，以及设置 → 微信的浏览器那一半。"
kind: "package-bundle"
---

# @deepseek-ai/wechat

[English](README.md) | 中文

## 概述

这一层挂载 owner 的频道：微信上的聊天 Session、给总线用的 `ctx.ownerNotifier`，以及设置 → 微信的浏览器那一半。聊天在 owner 追踪仓库的一份克隆里工作，每一轮的答案由 relay 的 `wechat` 频道带回去。这里的默认值是部署值：工作区路径、300 秒的媒体超时、hybrid 投递。

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
| `wechat-settings` | `@deepseek-ai/dsh-wechat-settings` | 设置 → 微信和设置 → 勿扰的浏览器页面 |
| `wechat` | `@deepseek-ai/dsh-wechat` | 微信聊天 Session、`ctx.ownerNotifier` 和 `wechat` relay 频道 |

### 它依赖什么

频道要认领的 `owner-relay`，以及决定一条消息是否等到早上的 `presence`。机器人账号绑定一次，存在 `$DSH_HOME/wechat/account.json`。

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

- [微信包](../../../packages/fork/wechat/README.zh.md)
- [owner relay 包](../../../packages/fork/owner-relay/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 没有 `$DSH_HOME/wechat/account.json` 时频道空转，消息进队列。
- 回复窗口由微信决定：只有 owner 最近发过消息时才能发出去。
