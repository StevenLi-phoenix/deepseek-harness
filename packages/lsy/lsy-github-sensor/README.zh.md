---
description: "lsy 事件总线的 GitHub 轮询传感器：来自配置仓库和 agent 运行时创建的 watch 的新 release、tag、分支提交与通知线程更新，用条件请求轮询，未变化的仓库不消耗限额。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-github-sensor

[English](README.md) | 中文

## 概述

关注任何你能读取的 GitHub 仓库，包括无法安装 webhook 的仓库，一分钟内得知新 release、tag、提交和通知更新。仓库来自配置，或由 agent 自己通过 `watch_create` 添加。每次轮询都是条件请求，未变化的仓库不消耗已认证的限额。新 watch 的第一次轮询只记录已有内容，所以添加 watch 不会刷屏。遇到限流时暂停轮询，之后自动恢复。

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

把它挂在 `@deepseek-ai/dsh-lsy-event-bus` 旁边，并提供两个 token：读仓库用的 fine-grained 只读 token 存为 `LSY_GITHUB_TOKEN`；如需通知，再提供一个只有 `notifications` scope 的 classic token，存为 `LSY_GITHUB_NOTIFICATIONS_TOKEN`（通知 API 只接受 classic token）。仓库可以列在配置里，也可以让 agent 用 `@deepseek-ai/dsh-lsy-tool-watch` 添加。

### 何时选用

没有 webhook 可用或仓库不归你所有时选它。在 GitHub 上 Watch 一个仓库，它的 issue、PR 和讨论就会进入 `/notifications`，由这个传感器跟踪。需要亚分钟级延迟时不要用它，改用 webhook 适配器。

### 最小配置

```yaml
- insert:
    - id: lsy-github-sensor
      name: '@deepseek-ai/dsh-lsy-github-sensor'
      config:
        repos:
          - repo: deepseek-ai/deepseek-harness
            watch: [releases, tags]
          - repo: octo/service
            watch: [commits]
            branch: main
```

所有 watch 都由 agent 创建时，这一行完全不需要 `config`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repos[].repo` | 必填 | `owner/name` |
| `repos[].watch` | `[releases]` | `releases`、`commits`、`tags` 任选，按此顺序发布 |
| `repos[].branch` | 默认分支 | `commits` 使用的分支 |
| `notifications` | `true` | 跟踪 `/notifications`；没有通知 token 时记一条 info 日志后跳过这个流 |
| `intervalMs` | `60000` | 轮询周期；`X-Poll-Interval` 可以拉长通知流的间隔 |
| `tokenEnv` / `notificationsTokenEnv` | `LSY_GITHUB_TOKEN` / `LSY_GITHUB_NOTIFICATIONS_TOKEN` | credential 引用 |
| `perPage` | `20` | 每次列表请求的条目数；两次轮询之间超过这个数的新条目会漏掉 |
| `maxTextChars` | `2000` | 保留的 release 说明与提交信息字符数 |
| `maxSeenPerStream` | `200` | 每个流记住的已见 id 数 |
| `timeoutMs` | `20000` | 单次请求的截止时间 |
| `apiBase` | `https://api.github.com` | REST 地址 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-github-sensor)是全部可用字段的权威来源。

### 运行时 watch

`ctx.lsyGithubSensor` 提供 `watch_create`、`watch_list`、`watch_delete` 使用的接口：

- `watch(ref, { repo, watch, branch? })`——校验 `owner/name`、非空的流子集，以及只能与 `commits` 同用的分支；以 `ref` 存储这个 watch（同一 ref 会被替换），并立即开始一次轮询，马上记录基线。
- `unwatch(ref)`——返回该 watch 是否存在，并删除不再有人轮询的流的游标，再次关注时会重新记录基线，而不是补发中间发生的内容。
- `watchedRepos()`——配置与 agent 的 watch，带 `origin`、`ref`，以及每个流的基线和最近一次轮询结果。
- `probe(repo, signal?)`——在仓库 token 可解析时带上它请求 `GET /repos/{owner}/{name}`；返回 `{ ok: true, fullName, private, defaultBranch }` 或 `{ ok: false, status, message }`（没有响应时 status 为 0），从不抛出。
- `credentialStatus()`——每个 token 引用能否解析，以及通知轮询是否打开；从不返回 token 的值。
- `cursor(stream)` 与 `pollStatus(stream)`——单个流已存储的游标和最近一次轮询结果。

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

每个 tick 轮询配置仓库与 agent 创建的仓库的并集，多个 watch 指向同一个流时只轮询一次，且不会与上一个 tick 重叠；tick 进行中创建的 watch 会在它之后紧接着再跑一个 tick。每个流在 `lsy_github_sensor` storage domain 里保存一个游标，键为 `repo:<owner/name>:<kind>`，设置了分支时为 `repo:<owner/name>:commits@<branch>`，两个分支不会共用游标：`ETag` 与 `Last-Modified` 校验值、最新的已见 id、基线标记，以及 `X-Poll-Interval` 给出的下次允许轮询时间。304 不改变任何东西。200 按从旧到新发布未见过的条目，之后才推进游标；如果发布失败，就丢弃校验值，让下次轮询重新拉取，已经到达的部分由总线去重。请求进行中被取消关注的流，其响应会被丢弃。草稿会被忽略而不是标为已见，所以之后正式发布仍算新条目。带 `retry-after` 或已耗尽 `x-ratelimit-reset` 的 403 或 429 会让所有流暂停到那个时间。agent 的 watch 存在同一个 domain 的 `watches` 表里。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、运行时 watch、probe、tick、条件请求、限流退避 |
| [`src/github.ts`](src/github.ts) | 响应解析与事件映射 |
| [`src/storage.ts`](src/storage.ts) | 游标表与 watch 表 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。`tests/fake-github.ts` 是带 ETag、Last-Modified、X-Poll-Interval 与限流行为的 REST 替身；`@deepseek-ai/dsh-lsy-tool-watch` 的测试复用了它。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [lsy 事件总线](../lsy-event-bus/README.zh.md)——发布的事件之后会怎样
- [Watch 工具](../lsy-tool-watch/README.zh.md)——agent 如何创建 watch
- [GitHub webhook 适配器](../../experimental/webhook-github/README.zh.md)——仓库归你所有时的推送方案

-----

<a id="model-experience"></a>
## 模型体验

### Session prompt 里的事件数据

#### 模型看到什么

这个传感器自己不提供 prompt 或工具。它的事件只经由 `@deepseek-ai/dsh-lsy-event-bus` 的 `session` 订阅到达模型，作为 `events_json` 的条目，带 `kind`、`subject`、`title`、`url`、`actor`、`occurredAt` 和 `text`（release 说明或提交信息，最多 `maxTextChars` 个字符）；`@deepseek-ai/dsh-lsy-tool-watch` 的 `watch_list` 报告每个流的 `baseline` 和 `last_poll`。

#### Token 影响

release 说明与提交信息占大头：每个事件最多 `maxTextChars` 个字符，再按订阅自己的 `maxTextChars` 和 `maxPromptEvents` 截断。

#### KV Cache 影响

与轮询无关：事件只会开启新 Session，它建立可复用的前缀，不会使已有前缀失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **追赶有上限**——两次轮询之间某个流的新条目超过 `perPage` 时，会漏掉一部分。
- **轮询状态只在内存里**——重启后 `lastPoll` 为空，直到每个流再被轮询一次。
- **不标记已读**——通知线程在 GitHub 上保持未读；每次线程更新都是一个新事件。
- **通知需要 classic token**——GitHub 的通知 API 不接受 fine-grained token。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 没有 `LSY_GITHUB_TOKEN` 时，GitHub 把每次轮询（包括 304 响应）都计入每小时 60 次的匿名限额；每个仓库每 60 秒最多轮询三类数据流，所以这样的部署几分钟内就会因限速暂停。

</details>
