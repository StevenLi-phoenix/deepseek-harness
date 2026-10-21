---
description: "lsy 事件总线的 GitHub 轮询传感器：新 release、tag、分支提交与通知线程更新，用条件请求轮询，未变化的仓库不消耗限额。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-github-sensor

[English](README.md) | 中文

## 概述

关注任何你能读取的 GitHub 仓库，包括无法安装 webhook 的仓库，一分钟内得知新 release、tag、提交和通知更新。每次轮询都是条件请求，未变化的仓库不消耗已认证的限额。第一次轮询只记录已有内容，所以打开传感器不会刷屏。遇到限流时暂停轮询，之后自动恢复。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把它挂在 `@deepseek-ai/dsh-lsy-event-bus` 旁边，列出仓库，并提供两个 token：读仓库用的 fine-grained 只读 token 存为 `LSY_GITHUB_TOKEN`；如需通知，再提供一个只有 `notifications` scope 的 classic token，存为 `LSY_GITHUB_NOTIFICATIONS_TOKEN`（通知 API 只接受 classic token）。

### 何时选用

没有 webhook 可用或仓库不归你所有时选它。在 GitHub 上 Watch 一个仓库，它的 issue、PR 和讨论就会进入 `/notifications`，由这个传感器跟踪。需要亚分钟级延迟时不要用它，改用 webhook 适配器。

### 最小配置

```yaml
- insert:
    - id: lsy-github-sensor
      name: '@deepseek-ai/dsh-lsy-github-sensor'
      config:
        notifications: true
        repos:
          - repo: deepseek-ai/deepseek-harness
            watch: [releases, tags]
          - repo: octo/service
            watch: [commits]
            branch: main
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repos[].repo` | 必填 | `owner/name` |
| `repos[].watch` | `[releases]` | `releases`、`commits`、`tags` 任选，按此顺序发布 |
| `repos[].branch` | 默认分支 | `commits` 使用的分支 |
| `notifications` | `false` | 跟踪 `/notifications`（需要通知 token） |
| `intervalMs` | `60000` | 轮询周期；`X-Poll-Interval` 可以拉长通知流的间隔 |
| `tokenEnv` / `notificationsTokenEnv` | `LSY_GITHUB_TOKEN` / `LSY_GITHUB_NOTIFICATIONS_TOKEN` | credential 引用 |
| `perPage` | `20` | 每次列表请求的条目数；两次轮询之间超过这个数的新条目会漏掉 |
| `maxTextChars` | `2000` | 保留的 release 说明与提交信息字符数 |
| `maxSeenPerStream` | `200` | 每个流记住的已见 id 数 |
| `timeoutMs` | `20000` | 单次请求的截止时间 |
| `apiBase` | `https://api.github.com` | REST 地址 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidshlsy-github-sensor)是全部可用字段的权威来源。

### 事件

| Kind | Key | Subject | Actor |
|---|---|---|---|
| `github.release` | `<repo>:release:<id>` | 仓库 | release 作者 |
| `github.tag` | `<repo>:tag:<name>` | 仓库 | — |
| `github.commit` | `<repo>:commit:<sha>` | 仓库 | GitHub 登录名，否则为 git 作者名 |
| `github.notification.<type>` | `notification:<thread>:<updated_at>` | 仓库 | — |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个 tick 依次轮询所有流，且不会与上一个 tick 重叠。每个流在 `lsy_github_sensor` storage domain 里保存一个游标：`ETag` 与 `Last-Modified` 校验值、最新的已见 id、基线标记，以及 `X-Poll-Interval` 给出的下次允许轮询时间。304 不改变任何东西。200 按从旧到新发布未见过的条目，之后才推进游标；如果发布失败，就丢弃校验值，让下次轮询重新拉取，已经到达的部分由总线去重。草稿会被忽略而不是标为已见，所以之后正式发布仍算新条目。带 `retry-after` 或已耗尽 `x-ratelimit-reset` 的 403 或 429 会让所有流暂停到那个时间。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、tick、条件请求、限流退避 |
| [`src/github.ts`](src/github.ts) | 响应解析与事件映射 |
| [`src/storage.ts`](src/storage.ts) | 游标表 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [lsy 事件总线](../lsy-event-bus/README.zh.md)——发布的事件之后会怎样
- [GitHub webhook 适配器](../../experimental/webhook-github/README.zh.md)——仓库归你所有时的推送方案

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `@deepseek-ai/dsh-lsy-event-bus`：这个传感器不提供 prompt 或工具；由 session 订阅决定它的哪些事件会到达模型。

#### KV Cache 影响

无关：轮询与发布从不触及模型请求。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **追赶有上限**——两次轮询之间某个流的新条目超过 `perPage` 时，会漏掉一部分。
- **不标记已读**——通知线程在 GitHub 上保持未读；每次线程更新都是一个新事件。
- **通知需要 classic token**——GitHub 的通知 API 不接受 fine-grained token。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。`tests/fake-github.ts` 是带 ETag、Last-Modified、X-Poll-Interval 与限流行为的 REST 替身。

</details>
