---
description: "event 服务的骨架层：日志、webhook 运行时、owner relay、事件总线与订阅、ingest、控制台和设置页的行，以及服务自己运行的预置。每个功能都是紧跟其后挂载的独立 bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-event-bundle

[English](README.md) | 中文

## 概述

这是 event profile 的骨架层。它挂载事件驱动 agent 服务在任何功能之前都要有的东西：日志、为总线创建 Session 的 webhook 运行时、owner relay、带全部订阅的事件总线、推送 ingest 路由、全部设置卡片、服务控制台，以及 `notify` 和 `unattended` 两个预置。之后每个功能以自己的 bundle 挂载，在 `fork/profiles/event/package.json` 里排在本层之后。去掉某个功能 bundle 服务照样能组合；去掉这一层，别的层就没有总线可发布。

## 目录

- [使用本包](#use-this-package)
- [各层与挂载顺序](#the-layers-and-their-order)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 装进 event profile

`fork/deploy/setup-profile.sh` 把 `fork/bundles/` 下的每个目录链接进 `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/`，并写好 profile 清单，清单里按挂载顺序列出各层。手动组合 profile 就自己建链接，并在 `dsh.profile.bundles` 里写名字：

```yaml
- insert:
    - id: event-bus
      name: '@deepseek-ai/dsh-event-bus'
```

### 骨架挂载什么

| 行 | 包 | 挂载什么 |
|---|---|---|
| `logger-console` | `@deepseek-ai/cordis-plugin-logger-console` | info 级的 stdout 日志，B 站账号和 owner relay 用 debug |
| `webhook-runtime` | `@deepseek-ai/dsh-webhook` | 总线为 `session` 订阅创建 Session 用的接缝 |
| `owner-relay` | `@deepseek-ai/dsh-owner-relay` | 每轮结束时一套规则，把答案交给认领了该 Session 的频道 |
| `time-gap` | `@deepseek-ai/dsh-time-gap` | 静默五分钟以上再开口时，排在前面那条时间提示 |
| `event-bus` | `@deepseek-ai/dsh-event-bus` | 路由：每条订阅、它的合并窗口、上限，以及它启动的 Session |
| `event-ingest` | `@deepseek-ai/dsh-event-ingest` | 推送路由 `POST /hooks/events`，每个 source 一个 token |
| `plugin-config` | `@deepseek-ai/dsh-plugin-config` | 每个设置页上的"全部设置"卡片 |
| `event-console` | `@deepseek-ai/dsh-event-console` | 设置 → 服务总览、订阅与监控、Claude Code 和语音 |
| `preset-notify` | `@deepseek-ai/dsh-agent-preset` | 通知台的 `notify` 预置：替主 agent 过滤和汇总 |
| `preset-unattended` | `@deepseek-ai/dsh-agent-preset` | `unattended` 预置：微信聊天 Session，以及 watch、提醒、事件启动的每个 Session |

insert 列表上面的九行覆盖 base 和 Web bundle 挂载的行：让这个实例保持 remote-first、把频道机器人 Session 计为自动化、把根上的 `working_directory` 工具移进 `unattended` 预置、保留先读后写和 DeepSeek 搜索提供方，并把 Agent Teams 挡在外面。

<a id="the-layers-and-their-order"></a>
## 各层与挂载顺序

profile 按 `dsh.profile.bundles` 的顺序把各层的 patch 合成一个扁平列表来应用，`insert` 是追加。所以功能 bundle 的行落在骨架之后，这正是所有依赖需要的方向：它们可以用骨架挂载的总线、relay、ingest source 和预置。下表就是 `fork/profiles/event/package.json` 写的挂载顺序。

| 层 | 加入什么 | 依赖 |
|---|---|---|
| `@deepseek-ai/dsh-event-bundle` | 上面这套骨架 | — |
| `@deepseek-ai/github` | GitHub App 路由、sensor | 它要发布到的总线 |
| `@deepseek-ai/headless-browser` | 一个常驻 Chromium | — |
| `@deepseek-ai/provider-balance` | 输入框停靠区胶囊 | — |
| `@deepseek-ai/subagent-activity` | 子智能体面板 | 按 slot 优先级盖住 `ui-subagent` |
| `@deepseek-ai/sysmon` | 设置 → 系统状态 | — |
| `@deepseek-ai/memory` | 设置 → 记忆页面和路由 | `owner-memory` 行写的记忆文件 |
| `@deepseek-ai/presence` | 睡眠状态、设置 → 勿扰 | 各通知方都读 `ctx.presence` |
| `@deepseek-ai/wechat` | 微信频道、设置 → 微信 | owner-relay 的 `wechat` 频道 |
| `@deepseek-ai/cc-admin` | 给控制台用的 `ctx.claudeCodeSessions` | 读它的控制台页面 |
| `@deepseek-ai/voice` | `ctx.voice` | unattended 预置里的 `speak` 工具 |
| `@deepseek-ai/bili` | B 站账号、`bili` 和 `up` 预置 | owner-relay 的 `bili-dm` 频道、点名这些预置的总线订阅 |
| `@deepseek-ai/qq` | QQ 观察者、设置 → QQ、`qq-digest` 和 `qq-main` 预置 | `qq-main` 订阅和 `tool-qq` 行 |
| `@deepseek-ai/courses` | 课程记录和 DDL 轮询 | 算免打扰要的 `ctx.presence` |
| `@deepseek-ai/gmail` | Gmail 账号、设置 → 邮箱 | `tool-gmail` 行 |
| `@deepseek-ai/qqbot` | 官方 QQ 机器人频道、`qqbot` 预置 | owner-relay 的 `qqbot` 频道 |
| `@deepseek-ai/integrity` | 完整性监视 | — |
| `@deepseek-ai/guard` | `ctx.contentGuard`、设置页 | 每个写公开文本的地方 |
| `@deepseek-ai/style` | 说话风格、设置 → 说话风格 | `ctx.contentGuard`、它挖掘的 QQ 和 B 站读取 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个功能 bundle 的 `cordis.patch.yml` 里就是这份文件原先的那些行，逐字搬过去，相对顺序不变；`fork/bundles/event/cordis.patch.yml` 留下骨架行和根上的覆盖。有测试把组合后的各层和旧的单文件组合对比，行不会被悄悄丢掉或改掉。

一个预置整块留在同一层。agent 预置的插件是一个 config 值（`config.plugins`），不是 patch 引擎能索引的 group，所以后面的层没法往预置里插东西：功能自己的预置（`bili`、`up`、`qqbot`、`qq-digest`、`qq-main`）跟着功能走，服务级的两个（`notify`、`unattended`）留在这里。

`unattended` 预置点名了好几个功能的工具（`tool-qq`、`tool-courses`、`tool-gmail`、`tool-voice`、`cc-bridge`、`tool-monitor`）。这些行随预置留在骨架里，因为别的层没法把它们补进预置。所以要删掉某个功能 bundle，也得把它的工具行从 `preset-unattended` 里删掉。

总线保留全部订阅。路由属于服务，不属于某个功能：订阅点名它需要的预置或 source，没挂载的功能只是不会触发自己那条订阅。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [GitHub sensor](../github/README.zh.md)
- [微信频道](../wechat/README.zh.md)
- [B 站账号](../bili/README.zh.md)
- [profile 与部署脚本](../../README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 想删掉某个功能 bundle，如果它在那里有工具行，就得同时改 `preset-unattended`。
- 改订阅要改 `@deepseek-ai/dsh-event-bundle`，不是改那些事件所属的功能 bundle。
