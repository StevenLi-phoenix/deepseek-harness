---
description: "事件服务的 QQ 群观察者：一个个人 QQ 号经同机的 OneBot v11 协议端（NapCat）潜伏在主人列出的群里，记录消息、下载图片、按需转写语音、定时做摘要，默认从不发言。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-qq

[English](README.md) | 中文

## 概述

让 agent 潜伏在 QQ 群里学习。一个个人 QQ 号扫码登录一次后待在你选定的群里。本包把每个群的消息、图片和语音记录在这台机器上，按计划为每个群写一份摘要（话题、定论、术语、常见问题、谁懂什么、链接），并让 agent 检索和阅读这一切。它从不发言、加好友或点赞：发送功能默认关闭，QQ 这一侧只读。

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

本包连接一个 OneBot v11 WebSocket 服务端，在这套环境里就是 colima 上 Docker 容器里的 NapCat（[`lsy/deploy/napcat/napcat.sh`](../../../lsy/deploy/napcat/napcat.sh)，RUNBOOK 第 13 步）。它提供 `ctx.lsyQq`，[`@deepseek-ai/dsh-lsy-tool-qq`](../lsy-tool-qq/README.zh.md) 把它的读取方法变成 agent 工具。它依赖 Host 的 Session Controller、permission preset、Session 标题和凭据存储；挂载了 `ctx.lsyVoice`（语音转写）和 `ctx.lsyNotifier`（掉线通知）时会用到它们。挂载后列出要记录的群：

```yaml
- insert:
    - id: lsy-qq
      name: '@deepseek-ai/dsh-lsy-qq'
      config:
        groups: ['123456789']
```

在列出群号之前什么都不记录：其他群的消息一到就丢弃，日志对每个这样的群只说一次（`not recording group <number> (<name>)`），群号就是这样找到的。私聊完全不存储。日志还会每十分钟报告一次各个未列出的群自启动以来出现了多少条消息（只是计数，什么都不保留），方便挑选活跃的群。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | `ws://127.0.0.1:3001` | 协议端的 WebSocket 地址；必须在本机（127.0.0.1、localhost）或 tailnet（100.64.0.0/10、`*.ts.net`）上 |
| `tokenEnv` | `LSY_QQ_ONEBOT_TOKEN` | 存放协议端 access token 的凭据名；以 Bearer 头发送；缺失时观察者保持离线 |
| `groups` | `[]` | 要记录的群号 |
| `dataDir` | `<DSH_HOME>/lsy-qq` | 数据库（`qq.db`）、下载（`media/`）和摘要的原始回答（`digest-raw/`）；以 0700 权限创建 |
| `media.images` | `true` | 下载已记录消息里的图片 |
| `media.maxImageBytes` | `15728640` | 下载的最大图片 |
| `media.maxTotalBytes` | `5368709120` | 下载总量达到这个值（5 GiB）就停止；日志每小时警告一次 |
| `media.retainDays` | `30` | 删除早于这么多天的消息的下载；`0` 为保留 |
| `retention.textDays` | `30` | 删除早于这么多天的原始消息（文字、原始片段、媒体行）；`0` 为保留。摘要不受影响 |
| `media.hostSuffixes` | QQ 的 CDN 域名 | 其他域名或 IP 地址上的媒体链接不会被抓取 |
| `media.timeoutMs` | `30000` | 单次下载的期限 |
| `voice.download` | `true` | 把语音消息存成 MP3（协议端负责解码 QQ 的 SILK） |
| `voice.maxBytes` | `10485760` | 保留的最大音频 |
| `asr.enabled` | `false` | 用 `ctx.lsyVoice.transcribe` 转写语音消息；需要 lsy-voice 的 `asr.enabled` |
| `honorRecall` | `true` | 发送者撤回的消息会丢掉文字、原始片段和文件 |
| `backfill.enabled`、`backfill.maxMessages` | `true`、`300` | 连接后补抓漏掉的消息（历史页向后翻，直到遇到已存的消息） |
| `send.enabled` | `false` | 是否允许 `sendGroupMessage` |
| `send.groups` | `[]` | 在 `send.enabled` 之外，允许发送的群 |
| `send.minIntervalSec`、`send.maxPerDay` | `60`、`10` | 对同一个群两次发送至少相隔这么久，每天至多这么多条 |
| `digest.enabled` | `true` | 按计划给每个已记录的群做摘要 |
| `digest.everyHours` | `24` | 同一个群两次摘要之间的小时数 |
| `digest.minMessages` | `15` | 新消息少于这个数的群等下一轮 |
| `digest.maxPromptChars` | `60000` | 每次模型调用的转录字符数；积压更多就拆开 |
| `digest.maxCallsPerRound` | `5` | 一个群在一轮里最多用几次模型调用 |
| `digest.aliasMembers` | `true` | 给摘要模型看到的成员是稳定的别名（`群友#a3f9`，QQ 号加盐的哈希），所以摘要里既没有名字也没有号码 |
| `digest.profiles` | `false` | 同时要求写“成员观点与专长”一节（按别名）；默认关闭：不做逐人画像 |
| `digest.keepPerGroup`、`digest.maxDigestChars` | `200`、`3000` | 每个群保留的摘要数（存新摘要时删最旧的）和单份摘要的最大字数 |
| `digest.provider`、`digest.model` | 未设置 | 摘要 Session 的模型（provider 路由和模型 id），例如便宜的模型；不设置就用 profile 的默认模型 |
| `digest.agentPreset`、`digest.permissionPreset` | `qq-digest`、`read-only` | 事件 bundle 的 `qq-digest` preset 只有人设、没有工具 |
| `digest.workspacePath`、`digest.timeZone`、`digest.timeoutMs` | `/Users/dsh-runtime/qq-digest`、`Asia/Shanghai`、`900000` | 工作目录、转录里时间所用的时区，以及等待一次模型调用的期限 |
| `offlineNoticeMs` | `600000` | 协议端这么久连不上、或报告账号下线时，经 `ctx.lsyNotifier` 通知 owner；`0` 关闭 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-qq)是全部可接受字段的完整来源。

摘要是观察者学到的知识，带着来源（`qq-group:<群号>`、摘要编号、日期）；它们不受 30 天限制，`forgetDigests({ groupId?, beforeMs? })`（即 `qq_forget` 工具）按群或日期删除。读取由服务负责：`groupOverview()`、`recentMessages()`、`searchMessages()`、`digests()` 和 `groupName()` 只对已记录的群作答。`sendGroupMessage(groupId, text)` 留给以后的代码，除非 `send.enabled` 为 true 且该群在 `send.groups` 里，否则一律拒绝；本包和工具里没有任何地方调用它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`OneBotClient`（[`src/onebot.ts`](src/onebot.ts)）用 Bearer 头带上 token 打开正向 WebSocket，两分钟没有任何数据就丢掉这个 socket（NapCat 每 30 秒一次心跳），按 `echo` 对应 API 调用，并从所有错误里抹掉 token。观察者以 2 秒到 2 分钟翻倍的间隔重连，稳定运行一分钟后重置。每次连上后，它读取登录信息（`get_login_info`）、刷新群列表（`get_group_list`，之后每小时一次），并为每个已记录的群补抓（`get_group_msg_history`，从最新一页向前，直到遇到已存的消息或 `backfill.maxMessages`）。

一条群消息经解析（[`src/text.ts`](src/text.ts)）成一行文字（`@name`、`[图片]`、`[语音]`、`[文件:name]`、`[卡片:title url]` 等）、被引用的消息 id 和它的媒体。[`src/store.ts`](src/store.ts) 以群号加 QQ 消息 id 为唯一键把它写入 SQLite（`node:sqlite`，WAL），所以重连和补抓不会产生重复行；FTS5 索引使用 trigram 分词器，支持中英文子串检索（不足三个字符的查询退回 `LIKE`）。图片只从 `media.hostSuffixes` 里的域名抓取，走 HTTPS、不跟随重定向、有大小上限、同时两个，存到 `media/<group>/<YYYYMM>/<sha256>.<ext>`（权限 0600；内容相同的字节共用一个文件）。语音消息经 `get_record` 取成 MP3（退而求其次用它的链接），同样保存，开启 `asr.enabled` 时由 lsy-voice 转写，转写文字会追加到消息文字和检索索引里。撤回通知会丢掉该消息的文字、原始片段、媒体行和文件。

每轮 `digest`（每十分钟检查一次）挑出上次摘要已满 `everyHours`、且有 `minMessages` 条新消息的群，把积压切成每份至多 `maxPromptChars` 的转录，对每份在 `qq-digest` preset 的新 Session 里跑一轮（没有工具、权限 `read-only`、配置的模型）。Session 的最终文字先写进 `digest-raw/` 再入库；`NO_REPLY` 的回答存一个占位，让游标往前走；每步的 usage 随摘要存储并记入日志。转录被框成不可信数据，也无法关闭自己的块。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、连接循环、事件处理、媒体下载、定时任务、读取和受限的发送 |
| [`src/onebot.ts`](src/onebot.ts) | OneBot v11 客户端和地址检查 |
| [`src/text.ts`](src/text.ts) | 消息片段到文字和媒体 |
| [`src/store.ts`](src/store.ts) | SQLite 表结构、FTS5 检索、保留期与摘要查询 |
| [`src/media.ts`](src/media.ts) | 地址白名单、有上限的抓取、类型识别、按内容命名的文件 |
| [`src/digest.ts`](src/digest.ts) | 转录切块、摘要提示词，以及经 Session 的模型调用 |

这是 fork 本地的包；[`../UPSTREAM.md`](../UPSTREAM.md) 说明 `lsy` 组如何跟踪上游。协议端是 NapCat：它在腾讯自己的 Linux QQ 客户端里加载插件，所以这里没有重新实现任何 QQ 协议。LLBot 的 macOS CLI 被否决，因为它用闭源原生模块给数据包签名，而这些模块会调用厂商的 token 服务；官方 QQ 开放平台机器人先做过又放弃了，因为机器人在群里只能看到 @ 它的消息，不能作为一个读取全部消息的成员。数据留在这台机器的 `dataDir` 下；离开这里的文字只有发给摘要模型的转录和 agent 经工具读到的内容。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [QQ 工具](../lsy-tool-qq/README.zh.md)——基于本服务的 `qq_groups`、`qq_digest`、`qq_recent`、`qq_search`
- [语音服务](../lsy-voice/README.zh.md)——语音消息的转写
- [Session Controller](../../api/session-controller/README.zh.md)——运行摘要 Session
- [Permission presets](../../interaction/permission-presets/README.zh.md)——摘要 Session 的 `read-only`

-----

<a id="model-experience"></a>
## 模型体验

### 摘要 Session

#### 模型看到什么

每份转录在新 Session 里是一条用户 prompt：一段英文指令，点名这个群、要写的小节标题（话题、结论与事实、术语与梗、常见问题、链接与资料；只有开启 `digest.profiles` 才加“成员观点与专长”）和 1500 字上限，然后是 `<qq_group_messages trust="untrusted">` 里的转录，每条消息一行，格式为 `[MM-DD HH:mm] 群友#a3f9 ↳reply: text`（成员默认是别名；关闭 `digest.aliasMembers` 时是名字加 QQ 号末四位）。preset 的人设说明聊天内容是数据、Session 没有工具。最终文字就是摘要；`NO_REPLY` 表示没有值得保留的内容。

#### Token 影响

每次调用至多 `maxPromptChars` 个字符的转录加约 300 token 的指令，回答至多约 1500 字；每个群每轮至多 `maxCallsPerRound` 次调用，默认每个群每天一轮。每步 usage 随摘要保存。

#### KV Cache 影响

每次调用都是带自己短前缀的新 Session；摘要之间不共享任何内容。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **保留期**——原始消息和下载在 30 天后删除；摘要里或消息文字里引用的名字，仍可能带着成员自己写的关于自己的信息。
- **非官方客户端，有封号风险**——NapCat 不是官方机器人：腾讯可能让账号下线或限制它。请用备用小号、保持只读，不要在很多地方登录。
- **只能看账号所在的群**——得有人先把这个号拉进每个群。
- **文字、图片和语音**——视频和群文件只记录元数据；合并转发的聊天记录记为 `[合并转发]`。
- **图片链接会过期**——下载失败或被跳过的图片只剩占位。
- **语音依赖协议端的解码器**——`get_record` 必须以 base64 返回音频，否则只存原始链接、不转写。
- **崩溃时至多一次**——进程挂掉期间到达的消息，补抓只能找回到 `backfill.maxMessages` 为止。
- **没有对着真实 QQ 验证过**——观察者只对本地的 NapCat 替身测试过；第一次真实登录要盯着日志。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 对消息做向量检索（经 registry 的 bge-m3）可以补充 trigram 检索；尚未决定。
- 按成员的画像（每个人懂什么）目前只存在于摘要里。
- 群文件不下载；`get_group_file_url` 可以做到。

</details>
