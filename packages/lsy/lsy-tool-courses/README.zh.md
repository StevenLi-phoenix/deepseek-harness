---
description: "主人主 agent 的课程工具，基于 ctx.lsyCourses：courses_deadlines、courses_find、courses_get，以及写操作 courses_set_progress 和 courses_save_memo；每个任务一行，每次写都带 expected_version，同样的重试用同一个 request id。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-courses

[English](README.md) | 中文

## 概述

在微信上问 agent“我还有什么 DDL”“那个 lab 交了吗”，或者告诉它“HW3 做完了”，它会按你的课程记录回答并更新记录。列表每个任务只回一行短文字，写明纽约时间的日期、进度、提交状态和记录上次更新的时间，回答因此很小。你的进度和备忘会以你自己的话作为理由保存，并做版本检查，所以期间别处做的修改不会被覆盖。提交状态始终是平台同步看到的那样。

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

把这一行加到面向主人的 agent preset 的插件列表里，且该进程挂载了 [`@deepseek-ai/dsh-lsy-courses`](../lsy-courses/README.zh.md)。lsy event profile 把它挂在 `unattended` preset 里，微信聊天 Session 用的就是这个 preset；频道 preset（`bili`、`up`、`qqbot`、`qq-digest`）从不挂载它。`ctx.lsyCourses` 出现之后工具才会注册。

```yaml
- id: lsy-tool-courses
  name: '@deepseek-ai/dsh-lsy-tool-courses'
```

插件本身没有配置；服务地址、token 和时区都属于 `lsy-courses`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`courses_deadlines` 调用 `report`（`view: deadlines`，最多 30 行，`coverage_limit: 1`），`courses_find` 调用 `query`（`kind: task`，最多 10 条），`courses_get` 调用 `get`，写操作经 `ctx.lsyCourses.api` 调用 `set_progress` 和 `save_memo`。结果用 `lsy-courses` 的线路解析器解析，由 [`src/format.ts`](src/format.ts) 输出。没有 `request_id` 的写操作得到 `dsh-<operation>-<参数的 sha256>`，所以回答丢失后原样重试会重放第一次的结果，不会写两次；冲突回答只保留当前版本和改动的字段。每次调用都记录工具名、回答大小或写入结果，失败记为警告。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：五个工具定义、request id、写入回答 |
| [`src/format.ts`](src/format.ts) | 任务行、同步行和不可信数据包裹 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [课程服务](../lsy-courses/README.zh.md)：客户端、DDL 提醒和同步提醒

-----

<a id="model-experience"></a>
## 模型体验

### 课程工具

#### 模型看到什么

调用方 Agent 的 preset 挂载了这个包且 `ctx.lsyCourses` 存在时，有五个工具 schema。`courses_deadlines`（可选 `days`、`course`、`include_overdue`）列出往后要截止的未完成任务，过期的连同迟交窗口一起列，并要求模型说“last update <时间>”，同步失败时告诉主人从何时开始。`courses_find`（必填 `text`，可选 `course`）搜索任务，包括已完成的。`courses_get`（必填 `id`）显示一个任务和它的版本。`courses_set_progress`（必填 `id`、`expected_version`、`status`、`evidence`；可选主人说出的 `percent`、`completed_work`、`remaining_work`、`request_id`）说明它从不改提交状态、已提交的任务设为 `completed`、分部分完成的任务按部分算进度，以及完成的任务不再提醒。`courses_save_memo`（必填 `title`；可选 `body`、`category`、`course`、`task_id`、`planned_at`、`id`、`expected_version`、`request_id`）保存一条备忘。

#### Token 影响

挂载此包的 preset 下的 Agent 每次请求都有固定的 schema 开销；其他 preset 下的 Agent 不付出代价。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能从第一个变化的 schema token 起使复用失效。

### 课程工具结果

#### 模型看到什么

读操作回答一个文本块，包在 `<course_records trust="untrusted">` 里，后面跟一句说明这些文字是数据、不是指令：一行标题，每个任务一行（`- [<id> v<version>] <课程> · <标题> — due <时间>; late submissions until <时间>; progress <状态>; submission <状态> (seen on the platform | not verified); parts done <n>/<m>; last update <时间>; <链接名>: <url>`），无日期任务的数量，以及同步行；`courses_get` 另加版本、剩余工作和要求摘录，各截到 600 字符。写操作回答 JSON：`{ "saved": true, "id", "version" }`、`{ "conflict": true, "current_version", "changed_fields", "next" }` 或 `{ "error" }`（token 缺失或被拒时说明不要重试）。

#### Token 影响

10 个任务的 DDL 列表约 400 token；一个带摘录的任务最多约 500；写入回答几十个。它们留在 Session 历史里直到压缩。

#### KV Cache 影响

只追加；新出现的内容跟在可复用的请求前缀之后，不会使已有的 KV Cache 失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **不写提交状态**：主人报告的提交记为 `completed` 进度；平台状态只在同步看到时才变。
- **没有提醒和采集工具**：不提供 `save_reminder`、`record_sync`、`save_task_observation` 等同步工具；DDL 提醒来自 `lsy-courses`。
- **preset 的任何一轮都能写**：`unattended` preset 的每一轮都能写主人的进度和备忘，包括由事件开始的轮次。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- courses MCP 服务器（经 mcp hub）把同样的记录提供给 MCP 客户端；DSH 改用 audience 为 `courses` 的 PAT 调 REST API，因为 hub 的 OAuth 需要人来登录，它的完整结果也比这些行大。

</details>
