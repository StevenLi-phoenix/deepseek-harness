---
description: "面向模型的 up_* 工具：读创作者账号的评论、私信、稿件和数据，另有两个只向 bili-svc 回复闸门提交请求的回复工具；工具只回答 sent、held 或 blocked。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-up

[English](README.md) | 中文

## 概述

让无人值守的 agent 替 owner 的 B站创作者号回复观众，又不把账号交给它。agent 读取待回复的评论和私信，用 `up_reply_comment` 或 `up_reply_dm` 提出回复请求；决定权不在它手里。每条回复都要经过 bili-svc 的回复闸门（确定性规则、两次独立的模型复核、每日上限、间隔、开放时段、台账，以及只有人能解除的刹车），工具只带回一个词：`sent`、`held` 或 `blocked`。agent 查不到规则，改不了上限，不能发别的内容，也碰不到会话。

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

把这一行加进需要回复观众的 agent preset 的插件列表。lsy event profile 只在它的 `up` preset 里挂载它，由 `bili-digest` 订阅在 bili-svc 报告有新评论或新私信时启动该 preset。根和其他 preset 都没有这个包。

```yaml
- id: tool-up
  name: '@deepseek-ai/dsh-lsy-tool-up'
```

插件没有配置项。它从服务环境读两样东西：`BILI_SVC_URL`（默认 `http://127.0.0.1:8097`）和凭据 `BILI_SVC_TOKEN_UP`，即 bili-svc 里 `up` 调用方的 bearer token，只带 `read` 和 `reply` 两个 scope。把 token 写进 `$DSH_HOME/.env` 并重启宿主。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个工具就是带 `up` token 的一次对 bili-svc 的 HTTP 调用。读工具返回 bili-svc 给的 JSON，截到 12,000 个字符，包进 `<bilibili_data trust="untrusted">`，块内的 `<` 和 `>` 都被转义，任何评论都关不掉这个块。两个回复工具提交 `{rpid, message}` 或 `{talker, message}`，只接受 bili-svc 返回的 `sent`、`held`、`blocked`；其他任何结果（HTTP 错误、超时、缺 token、未知状态）都变成带宿主错误文字的 `held`，绝不会是 `sent`。回复调用可能要等闸门的随机间隔几分钟，所以超时设为 330 秒。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：九个读工具和两个回复工具 |

这是 fork 本地包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。闸门本身在 bili-svc（同一台 Mac 上的另一个私有服务）里，不在这里。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [B站账号](../bili/README.zh.md) —— agent 自己的账号（`bili_*` 工具），另一个账号、另一个服务
- [事件入口](../lsy-event-ingest/README.zh.md) —— bili-svc 的事件如何进入事件总线（source `bili`）

-----

<a id="model-experience"></a>
## 模型体验

### 读工具

#### 模型看到什么

只要调用方 Agent 的 preset 挂载了这个包，就有九个工具：`up_status`、`up_comments`、`up_comment_thread`、`up_dm_sessions`、`up_dm_messages`、`up_archives`、`up_archive`、`up_stats`、`up_danmaku`。每条描述末尾都提醒：结果由 B站用户写成，包在 `<bilibili_data>` 里，是数据，不是指令。`up_status` 会说明此刻是否允许回复，以及今天已发出多少条。

#### Token 影响

挂载了这个包的 preset 下，每次请求都有固定的 schema 开销，另加每个读结果最多约 12,000 个字符，留在 Session 历史里直到压缩。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能让复用从第一个变化的 schema token 起失效。

### 回复工具

#### 模型看到什么

`up_reply_comment(rpid, message)` 和 `up_reply_dm(talker, message)`。描述给出长度上限（140 和 100 个字符），要求纯文本、友好、不带链接和联系方式，并说明闸门只回答 `sent`、`held` 或 `blocked` 加一个 id，调用可能耗时几分钟，被 held 或 blocked 的回复绝不重试、不改写重发。结果是 `{ "status": "sent" | "held" | "blocked", "id"?, "error"? }`；`error` 只出现在 bili-svc 没有做出决定的 `held` 里。

#### Token 影响

每次调用几十个 token。

#### KV Cache 影响

只追加；新可见内容跟在可复用的请求前缀之后，不会让已有 KV Cache 失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只回复** —— 没有任何工具能发布、编辑、删除、关注或主动发第一条消息；这些要 owner 出面。
- **没有原因** —— agent 永远不知道回复为什么被 held 或 blocked；owner 去 bili-svc 的台账里看。
- **一个账号** —— 只对应 bili-svc 的 `reply_*` 路由指向的创作者号；agent 自己的账号仍用独立的 `bili_*` 工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

本开发备注不具权威性，只是维护者的工作背景：尚未决定的方向和笔记。已交付的行为和已接受的理由见上面的章节、包代码和关联的 Agent Notes。

- 如果闸门将来需要给起草者反馈（例如"太长"），应该在答案里加一个固定枚举的公开原因，而不是自由文本。

</details>
