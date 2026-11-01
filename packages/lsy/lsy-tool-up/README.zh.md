---
description: "面向模型的 up_* 工具：创作者账号的读工具、两个只向 bili-svc 回复闸门提交请求的回复工具（sent、held 或 blocked）、不涉及个人的频道笔记，以及给 style_propose 用的 B站证据校验。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-up

[English](README.md) | 中文

## 概述

让无人值守的 agent 替 owner 的 B站创作者号回复观众，又不把账号交给它。agent 读取待回复的评论和私信，用 `up_reply_comment` 或 `up_reply_dm` 提出回复请求。由 bili-svc 的回复闸门决定（规则、两次模型复核、上限、台账、只有人能解除的刹车），工具只带回一个词：`sent`、`held` 或 `blocked`。agent 查不到规则，改不了上限，也不能发别的内容。一个常驻 Session 通过工具调用了解频道：`bili_channel_note` 保存不涉及个人的短笔记，`ctx.biliEvidence` 让 lsy-style 的 `style_propose` 校验它引用的评论。

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

把这一行加进需要回复观众的 agent preset 的插件列表，放在隔离 `biliEvidence` 的 group 里：插件提供这个服务，而 preset 注册表拒绝在 isolate realm 之外发布服务的 preset 行。lsy event profile 只在它的 `up` preset 里挂载它，即 `bili-digest` 订阅的常驻 Session（lsy-event-bus 的 `session.persistent`）。根和其他 preset 都没有这个包。读取 `ctx.biliEvidence` 的行（lsy-style 的 `style_propose`）放进同一个 group。

```yaml
- id: bili-channel
  name: cordis:group
  group: true
  isolate:
    biliEvidence: true
  config:
    - id: tool-up
      name: '@deepseek-ai/dsh-lsy-tool-up'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `subscription` | `bili-digest` | 只有这个总线订阅当前的常驻 Session 能调用 `bili_channel_note` 和 `ctx.biliEvidence`；其他 Session 一律拒绝 |
| `callsPerTurn` | `5` | 每轮 `bili_channel_note` 的调用次数，证据校验另行计数 |
| `notes.file` | `<DSH_HOME>/lsy-tool-up/channel-notes.json` | 笔记文件 |
| `notes.maxEntries` | `30` | 保存的笔记条数；满了之后先删一条才能再加 |
| `notes.maxChars` | `40` | 单条笔记最多字符数 |
| `evidence.saltFile` | `<DSH_HOME>/lsy-tool-up/evidence-salt` | 发送者 key 的秘密盐，首次使用时创建（权限 0600） |
| `evidence.cacheSize` | `2000` | 从 Session 读过的内容里记住的评论条数 |
| `evidence.maxIds` | `20` | 每次证据调用查的 id 数 |

它从服务环境读两样东西：`BILI_SVC_URL`（默认 `http://127.0.0.1:8097`）和凭据 `BILI_SVC_TOKEN_UP`，即 bili-svc 里 `up` 调用方的 bearer token，只带 `read` 和 `reply` 两个 scope。把 token 写进 `$DSH_HOME/.env` 并重启宿主。

证据校验是 `ctx.biliEvidence.evidenceOf(ids, { sessionId })`：`ids` 是十进制字符串形式的评论 rpid，返回能校验的评论 `Array<{ id, senderKey, at, text }>`（`senderKey` 是用盐对 `bili:<mid>` 做 HMAC-SHA256 后取的 32 个十六进制字符，`at` 是毫秒）。拒绝时抛出 `BiliEvidenceRefusedError`，code 为 `not_persistent_session` 或 `turn_cap`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个工具就是带 `up` token 的一次对 bili-svc 的 HTTP 调用。读工具返回 bili-svc 给的 JSON，截到 12,000 个字符，包进 `<bilibili_data trust="untrusted">`，块内的 `<` 和 `>` 都被转义，任何评论都关不掉这个块。两个回复工具提交 `{rpid, message}` 或 `{talker, message}`，只接受 bili-svc 返回的 `sent`、`held`、`blocked`；其他任何结果（HTTP 错误、超时、缺 token、未知状态）都变成带宿主错误文字的 `held`，绝不会是 `sent`。回复调用可能要等闸门的随机间隔几分钟，所以超时设为 330 秒。

频道笔记存在这个包自己的 JSON 文件里（权限 0600），其他插件都不读不写：不会进入 lsy-memory，`unattended`（微信）preset 也从不挂载这个包。添加时先规范化（NFKC、合并空白），以下情况拒绝：为空、太长、重复、列表已满，或含个人信息：姓名（称谓、自我介绍、拉丁全名）、UID 或任意五位以上连续数字、电话或联系账号、邮箱、地址、学校或单位、与个人相关的地点、@ 账号。笔记以一条 `<bili_channel_notes trust="untrusted-derived">` 用户消息（source `lsy-tool-up`，form `notice`）进入 Session：第一次请求时、每次压缩之后、以及笔记有变化后的下一轮开始时。

bili-svc 没有按 id 取单条评论的端点，所以证据校验先从这个插件已经通过 `up_comments` 和 `up_comment_thread` 返回过的评论里找（按 rpid 缓存），没找到再读现有的 `GET /v1/comments/{rpid}/thread`（根评论楼的第一页）。创作者自己账号（`/v1/status` 的 `accounts[].mid`）的评论永远不算证据；在这些 id 未知时，一律不算。原始 UID 不会离开插件。笔记工具和证据校验都会问 `ctx.lsyEventBus.persistentSubscriptionOf(sessionId)`，按 Session 计数直到该轮结束，并记录每次结果。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：九个读工具、两个回复工具、`bili_channel_note`、笔记块和 `ctx.biliEvidence` |
| [`src/notes.ts`](src/notes.ts) | 笔记文件和笔记块 |
| [`src/pii.ts`](src/pii.ts) | 笔记的个人信息规则 |
| [`src/evidence.ts`](src/evidence.ts) | 评论解析、rpid 缓存、发送者 key 和盐 |

这是 fork 本地包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。闸门本身在 bili-svc（同一台 Mac 上的另一个私有服务）里，不在这里。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [B站账号](../bili/README.zh.md) —— agent 自己的账号（`bili_*` 工具），另一个账号、另一个服务
- [事件入口](../lsy-event-ingest/README.zh.md) —— bili-svc 的事件如何进入事件总线（source `bili`）
- [事件总线](../lsy-event-bus/README.zh.md) —— 常驻的 `bili-digest` Session、用压缩摘要接续的轮换，以及 `persistentSubscriptionOf`

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

### 频道笔记

#### 模型看到什么

`bili_channel_note(op, text)`，`op` 为 `add` 或 `remove`；描述给出上限，要求笔记写频道整体、绝不写某一位观众，并说明每轮调用有上限、只能在频道的常驻 Session 里用。结果是 `{ "status": "added" | "removed", "id", "count" }` 或 `{ "status": "refused", "reason", "pii"?, "count"? }`。笔记以 `<bili_channel_notes trust="untrusted-derived">` 块回到模型面前，块里是一个 JSON 列表，开头说明这些是模型根据观众的话写下的笔记，要当数据读。

#### Token 影响

一个 schema，每次调用几十个 token，每个块最多 30 条、每条 40 个字符；块在第一次请求、压缩之后、以及笔记变化后的下一轮开始时加入。

#### KV Cache 影响

只追加；块跟在已认领的 prompt 之后，不会让已有 KV Cache 失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只回复** —— 没有任何工具能发布、编辑、删除、关注或主动发第一条消息；这些要 owner 出面。
- **没有原因** —— agent 永远不知道回复为什么被 held 或 blocked；owner 去 bili-svc 的台账里看。
- **一个账号** —— 只对应 bili-svc 的 `reply_*` 路由指向的创作者号；agent 自己的账号仍用独立的 `bili_*` 工具。
- **证据范围** —— 只有本进程里 Session 读过的评论，或位于其根评论楼第一页的评论能被校验；更早的评论不计。
- **笔记只在磁盘上** —— owner 在 JSON 文件里查看或删除笔记；暂时没有对应的 Settings 页面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

本开发备注不具权威性，只是维护者的工作背景：尚未决定的方向和笔记。已交付的行为和已接受的理由见上面的章节、包代码和关联的 Agent Notes。

- 如果闸门将来需要给起草者反馈（例如"太长"），应该在答案里加一个固定枚举的公开原因，而不是自由文本。

</details>
