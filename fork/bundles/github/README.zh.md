---
description: "event 服务的 GitHub 集成层：App webhook 路由，以及把投递和轮询变成总线事件的 sensor。"
kind: "package-bundle"
---

# @deepseek-ai/github

[English](README.md) | 中文

## 概述

这一层挂载 event 服务的 GitHub 一端。GitHub 投递到 App 路由，HMAC 校验是唯一的信任边界；sensor 把投递和它自己的轮询变成总线事件。之后由总线决定什么到达某个 Session；这一层自身不加任何订阅。

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
| `webhook-github` | `@deepseek-ai/dsh-webhook-github` | `POST /hooks/github` 路由：source `github-app`，密钥 `GITHUB_WEBHOOK_SECRET` |
| `github-sensor` | `@deepseek-ai/dsh-github-sensor` | 把投递和轮询变成总线事件 |

### 它依赖什么

sensor 往其中发布事件的 event bus，以及插件从凭据库或 `$DSH_HOME/.env` 读取的 `GITHUB_WEBHOOK_SECRET`、`GITHUB_SENSOR_TOKEN` 和可选的 `GITHUB_SENSOR_NOTIFICATIONS_TOKEN`。

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

- [GitHub sensor 包](../../../packages/fork/github-sensor/README.zh.md)
- [event 骨架](../event/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 没有密钥时路由拒收每一次投递；sensor 仍会按自己的轮询读取它能读到的内容。
