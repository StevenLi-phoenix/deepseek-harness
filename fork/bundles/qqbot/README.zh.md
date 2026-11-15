---
description: "event 服务的官方 QQ 机器人频道层：ctx.qqBot、它的白名单，以及 qqbot 预置。"
kind: "package-bundle"
---

# @deepseek-ai/qqbot

[English](README.md) | 中文

## 概述

这一层挂载官方 QQ 机器人频道，默认关闭。打开后它回 owner 列出的 openid 的私聊和被 @ 到的群，每个聊天一个 Session，走 relay 的 `qqbot` 频道和 `qqbot` 预置。它不是 QQ 观察者，也不需要观察者。

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
| `qqbot` | `@deepseek-ai/dsh-qqbot` | 机器人频道，owner 打开之前不挂 |
| `preset-qqbot` | `@deepseek-ai/dsh-agent-preset` | `qqbot` 预置：人格、时间、说话风格 |

### 它依赖什么

`qqbot` 频道要的 `owner-relay`、`$DSH_HOME/.env` 里的 `QQBOT_APP_ID` 和 `QQBOT_APP_SECRET`（或用登录脚本建的机器人），以及 profile patch 里 owner 的 openid。

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

- [QQ 机器人包](../../../packages/fork/qqbot/README.zh.md)
- [owner relay 包](../../../packages/fork/owner-relay/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 这里写的是 `disabled: true`：要在 profile patch 里打开并列出 openid。
- `allow` 初始为空，列进去之前谁都不会被回。
