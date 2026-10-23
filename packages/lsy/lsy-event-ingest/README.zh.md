---
description: "主人自己的服务通过带认证的 POST /hooks/lsy 路由向 lsy 事件总线推送事件：每个来源一个 bearer token，由 token 而不是请求体决定来源，字段有界，按 key 去重。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-ingest

[English](README.md) | 中文

## 概述

让你自己的服务在有事时通知 agent，只要一次带认证的 HTTP POST：流水线失败、任务完成、磁盘写满。每个服务有自己的 token，由 token 而不是请求体决定事件来自哪个来源，因此泄露的 token 冒充不了 GitHub 或别的服务。事件随后由事件总线去重，并分发到一条通知或一个无人值守的 agent Session。这里不排队；收不到回复的服务用同一个 `key` 重试。

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

把路由挂在运行 `@deepseek-ai/dsh-lsy-event-bus` 和 Host web server 的进程里，在凭据存储中给每个推送的服务一个专属 token，再为它的事件加一个总线订阅。lsy event bundle 挂载时只有一个来源 `kaorou`，它的 token `LSY_INGEST_TOKEN_KAOROU` 放在 `$DSH_HOME/.env`；它的 `kaorou` 订阅会为 `kaorou.*` 事件启动一个诊断 Session（见 [bundle patch](../../../lsy/bundles/event/cordis.patch.yml)）。

### 何时选用

当你运行的某个服务一有消息就应该唤醒 agent 时选用。GitHub 已有 `@deepseek-ai/dsh-lsy-github-sensor`，不要用它；agent 自己就能盯的东西，交给 `@deepseek-ai/dsh-lsy-tool-monitor` 的 `monitor_start`。

### 最小配置

```yaml
- id: lsy-event-ingest
  name: '@deepseek-ai/dsh-lsy-event-ingest'
  config:
    sources:
      - id: kaorou
        tokenEnv: LSY_INGEST_TOKEN_KAOROU
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `/hooks/lsy` | 路由路径；必须以 `/hooks/` 开头，且不以 `/` 结尾 |
| `sources` | `[]` | 允许推送的服务；为空时每个请求都得到 503 |
| `sources[].id` | 必填 | 总线上的来源 id：小写字母、数字和连字符，最长 32 个字符，不能重复，不能是 `github` 或 `schedule` |
| `sources[].tokenEnv` | 必填 | 保存该来源 bearer token 的凭据引用 |
| `maxBodyBytes` | `65536` | 接受的最大请求体，至少 1024 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-event-ingest)是所有可接受字段的完整来源。

每个 token 用一个足够长的随机值，例如 `openssl rand -hex 32`，以 `tokenEnv` 给出的名字存入 `$DSH_HOME/.env`，并把同一个值交给推送的服务。修改 `.env` 后重启 host。token 未设置或为空的来源无法推送。

### 推送事件

```sh
curl -sS -X POST http://127.0.0.1:3081/hooks/lsy \
  -H "Authorization: Bearer $LSY_INGEST_TOKEN_KAOROU" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"kaorou.job.failed","key":"job-91-attempt-3","subject":"job 91","title":"burn failed: ffmpeg exit 255","text":"stderr tail"}'
```

事件服务监听 `127.0.0.1:3081`。只要有订阅匹配，上面的请求就返回 `202` 和 `{"outcome":"accepted"}`。请求体是一个 JSON 对象，每个请求一个事件，只接受下面这些字段：

| 字段 | 必填 | 规则 |
|---|---|---|
| `kind` | 是 | 以 `<source>.` 开头的点分小写单词，例如 `kaorou.job.failed`；最长 100 个字符 |
| `key` | 是 | 去重键，在来源内唯一；1-200 个字符 |
| `subject` | 是 | 事件关于什么；1-200 个字符 |
| `title` | 是 | 单行标签；1-300 个字符 |
| `text` | 否 | 模型当作不可信数据来读的详情；最长 8000 个字符 |
| `url` | 否 | `http` 或 `https` 链接；最长 2000 个字符 |
| `occurredAt` | 否 | 发生时间，以纪元毫秒表示 |

`key`、`subject` 和 `title` 中的空白会折叠成单个空格。其他字段一律拒绝，包括 `source` 和 `actor`：来源只由 token 决定，推送的事件不带 actor。

### 回复

| 状态 | 响应体 | 含义 |
|---|---|---|
| 202 | `{ "outcome": "accepted" }` | 至少进入了一个订阅的队列 |
| 202 | `{ "outcome": "duplicate" }` | 总线已有这个 `source` 和 `key` |
| 202 | `{ "outcome": "suppressed" }` | 总线的抑制标记命中了标题或文本 |
| 202 | `{ "outcome": "unmatched" }` | 已存储，但没有订阅匹配该事件 |
| 400 | `{ "error": "…" }` | 请求体不是 UTF-8 或 JSON，或某个字段违反规则；消息会指出字段 |
| 401 | `{ "error": "…" }` | 没有 bearer token，或 token 不属于任何来源 |
| 405 | `{ "error": "…" }` | 方法不是 `POST`；`Allow` 头会说明 |
| 413 | `{ "error": "…" }` | 请求体超过 `maxBodyBytes` |
| 415 | `{ "error": "…" }` | Content-Type 不是 `application/json` |
| 503 | `{ "error": "…" }` | 没有任何来源配置了 token，或总线失败 |

`key` 是幂等键。服务用同一个 `key` 重试推送，永远不会让事件翻倍；会反复出现的故障则需要每次发生都换一个新 `key`，例如 `job-91-attempt-3`。总线记住最近 `retainEvents` 个事件（默认 5000），包括 `unmatched` 的，所以一个当时没人匹配的 key，在之后加上订阅时仍是 `duplicate`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

挂载时 `apply` 检查配置，遇到 `/hooks/` 之外的路径、格式错误或重复的来源 id、保留 id（`github` 和 `schedule`）就抛错。然后它在 `ctx.webServer` 上注册一条精确匹配的路由。处理每个请求时，处理器依次检查方法、`Authorization: Bearer` 头、token、Content-Type、请求体和事件字段，所以没有有效 token 的调用方了解不到载荷规则。

token 检查会从凭据存储解析每个来源的 token，跳过未设置的，并用 `timingSafeEqual` 比较传入值与存储值的 SHA-256 摘要，因此长度和内容都不会从耗时中泄露。匹配到的来源成为事件的 `source`。随后 `src/event.ts` 里的 `eventFrom` 按 `LIMITS` 校验请求体并构造 `LsyEventInput`，要求 `kind` 以 `<source>.` 开头；`ctx.lsyEventBus.publish()` 返回的结果作为 `202` 回给调用方。任何意外失败都回答 `503 ingest unavailable`。日志记录来源、kind、key 和结果，对被拒绝的推送只发警告而不带 token，也从不记录事件文本。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置检查、路由、token 匹配、读取请求体、回复 |
| [`src/event.ts`](src/event.ts) | 字段上限与请求体到事件的校验 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。测试用真实 HTTP 服务器提供该路由，并用假的 `webServer`、`credentials` 和 `lsyEventBus` 服务。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [事件总线](../lsy-event-bus/README.zh.md)——去重、订阅、合批、限流与 Session prompt
- [GitHub 传感器](../lsy-github-sensor/README.zh.md)——另一个事件来源
- [Web server](../../host/webserver/README.zh.md)——本包注册路由所在的路由表
- [凭据](../../credentials/credentials/README.zh.md)——token 的解析来源

-----

<a id="model-experience"></a>
## 模型体验

### Session prompt 中的事件数据

#### 模型看到的内容

本包自己不添加 prompt 或工具。推送的事件只通过 `@deepseek-ai/dsh-lsy-event-bus` 的 `session` 订阅到达模型，作为 `events_json` 的一项，包含 `id`（`<source>:<key>`）、`source`、`kind`、`subject`、`title`、`url`、`occurredAt` 和 `text`（按订阅的 `maxTextChars` 截断）。推送的事件没有 `actor`。总线把这个列表标成不可信数据，由订阅自己的 `instructions` 给出任务框架。

#### Token 影响

每个事件的 `text` 最多 8000 个字符，再被截到订阅的 `maxTextChars`（默认 2000），一个 prompt 里最多 `maxPromptEvents` 个事件（默认 50）。

#### KV Cache 影响

推送从不触碰已有的 Session：每个批次开一个新 Session，建立而不是破坏可复用前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **token 就是全部凭据**——没有请求体签名，重放只受 `key` 去重限制；把路由放在回环地址或 tailnet 上，轮换 token 时先改凭据存储和服务端，再重启 host。
- **路由本身没有限流**——持有 token 的一方可以推送许多不同的 key；总线靠去重、合批和 `maxPerHour` 限制到达模型的量，而不是拒绝请求。
- **每个请求一个事件**——有十个事件的服务要推送十次。
- **token 必须各不相同**——两个来源的 token 值相同时，列表里靠后的来源生效。
- **推送的事件没有 actor**——总线分不出一次推送是不是由 agent 自己的操作引起的，所以对 agent 的工作做出反应的服务，需要在标题或文本里带上抑制标记。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 是否允许来源声明 `actor`，使总线的身份抑制能作用于推送的事件，尚未决定。

</details>
