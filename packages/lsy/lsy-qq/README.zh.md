---
description: "事件服务的 QQ 群观察者：qq-recorder 服务独占与 OneBot v11 协议端（NapCat）的唯一连接并记录主人列出的群；本插件是它的客户端，定时做摘要、保存摘要和笔记、让 agent 阅读这一切，从不发言。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-qq

[English](README.md) | 中文

## 概述

让 agent 潜伏在 QQ 群里学习。一个个人 QQ 号扫码登录一次后待在你选定的群里。一个独立的小服务 qq-recorder 独占这个号的唯一连接，把每个群的消息、图片和语音记录在这台机器上；本包向它读取这些内容，按计划为每个群写一份摘要（话题、定论、术语、常见问题、谁懂什么、链接），并让 agent 检索和阅读这一切。连接在记录器里，所以重启或重新部署 DSH、保存设置都不会让 QQ 重连。它从不发言、加好友或点赞：发送一律拒绝，QQ 这一侧只读。

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

OneBot v11 WebSocket 服务端是 colima 上 Docker 容器里的 NapCat（[`lsy/deploy/napcat/napcat.sh`](../../../lsy/deploy/napcat/napcat.sh)，RUNBOOK 第 13 步）。唯一连接它的进程是 **qq-recorder**（[`lsy/deploy/qq-recorder`](../../../lsy/deploy/qq-recorder/)，独立进程的 AMS 服务，RUNBOOK §19）：数据库、下载和连接都归它，DSH 从不打开。本包是记录器的客户端：把下面的设置推给它，经它带版本的 API（`src/protocol.ts`，zod DTO，两端都校验，unix socket，bearer token）读取已记录的消息，并提供 `ctx.lsyQq`，[`@deepseek-ai/dsh-lsy-tool-qq`](../lsy-tool-qq/README.zh.md) 把它的读取方法变成 agent 工具。它依赖 Host 的 Session Controller、permission preset、Session 标题、凭据存储和 storage domain；挂载了 `ctx.lsyNotifier`（掉线通知）时会用到它。挂载后列出要记录的群：

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
| `tokenEnv` | `LSY_QQ_ONEBOT_TOKEN` | 存放协议端 access token 的记录器 AMS secret 名（必须以 `LSY_QQ_` 开头）；由记录器以 Bearer 头发送；缺失时记录器保持离线 |
| `groups` | `[]` | 要记录的群号。可热更新：设置 → QQ 里增删群，观察者立即跟随，并保存到 profile patch（新加的群会补抓历史） |
| `dataDir` | 未设置 | 被忽略，日志会警告：数据库（`qq.db`）、下载（`media/`）和状态文件归记录器，位于它声明里的 `QQ_RECORDER_DATA_DIR`（`/Users/dsh-runtime/.dsh/lsy-qq`）；DSH 自己的摘要原始回答写到 `<DSH_HOME>/lsy-qq-digest/raw/` |
| `media.images` | `true` | 下载已记录消息里的图片 |
| `media.maxImageBytes` | `15728640` | 下载的最大图片 |
| `media.maxTotalBytes` | `5368709120` | 下载总量达到这个值（5 GiB）就停止；日志每小时警告一次 |
| `media.retainDays` | `30` | 删除早于这么多天的消息的下载；`0` 为保留 |
| `retention.textDays` | `30` | 删除早于这么多天的原始消息（文字、原始片段、媒体行）；`0` 为保留。摘要不受影响 |
| `media.hostSuffixes` | QQ 的 CDN 域名 | 其他域名或 IP 地址上的媒体链接不会被抓取 |
| `media.timeoutMs` | `30000` | 单次下载的期限 |
| `voice.download` | `true` | 把语音消息存成 MP3（协议端负责解码 QQ 的 SILK） |
| `voice.maxBytes` | `10485760` | 保留的最大音频 |
| `asr.enabled` | `false` | 音频归记录器，目前不提供语音转写；设为 `true` 会让加载失败 |
| `honorRecall` | `true` | 发送者撤回的消息会丢掉文字、原始片段和文件 |
| `backfill.enabled` | `true` | 连接后补抓漏掉的消息 |
| `backfill.maxMessages` | `20` | 每个群最多补抓的消息数（一页就是这个数；往前翻页也只到这个总数为止） |
| `backfill.maxGroups` | `5` | 每次连接补抓的群数；下一次连接接着补后面的群 |
| `backfill.gapMs` | `5000` | 两个群的补抓之间的停顿，另加最多一半的随机抖动 |
| `backfill.skipWithinMs` | `1800000` | 距上一次断线不到这么久就重连时不补抓，免得连接抖动时反复冲击账号；`0` 表示从不跳过 |
| `backfill.minIntervalMs` | `1800000` | 补抓最多隔这么久做一次，插件重启时同样有效（记录器把时间记在 `connection-state.json`）；`0` 表示不限 |
| `send.enabled` | `false` | 不提供发送（记录器没有发送端点）；设为 `true` 会让加载失败 |
| `send.groups` | `[]` | 发送被拒绝期间不使用 |
| `send.minIntervalSec`、`send.maxPerDay` | `60`、`10` | 发送被拒绝期间不使用 |
| `digest.enabled` | `true` | 按计划给每个已记录的群做摘要 |
| `digest.everyHours` | `24` | 同一个群两次摘要之间的小时数 |
| `digest.minMessages` | `15` | 新消息少于这个数的群等下一轮 |
| `digest.maxPromptChars` | `60000` | 每次模型调用的转录字符数；积压更多就拆开 |
| `digest.maxCallsPerRound` | `5` | 一个群在一轮里最多用几次模型调用 |
| `digest.aliasMembers` | `true` | 给摘要模型看到的成员是稳定的别名（`群友#a3f9`，QQ 号加盐的哈希），所以摘要里既没有名字也没有号码 |
| `digest.profiles` | `false` | 同时要求写“成员观点与专长”一节（按别名）；默认关闭：不做逐人画像 |
| `digest.keepPerGroup`、`digest.maxDigestChars` | `200`、`3000` | 每个群保留的摘要数（存新摘要时删最旧的）和单份摘要的最大字数 |
| `digest.provider`、`digest.model` | 未设置 | 摘要 Session 的模型（provider 路由和模型 id），例如便宜的模型；不设置就用 profile 的默认模型 |
| `digest.resident` | `true` | 每个群一个常驻 Session，每轮恢复同一个，由 preset 的 compaction 压缩历史，每隔 `retention.textDays` 天替换；`false` 表示每轮新建一个 Session |
| `digest.archiveSessions` | `true` | 一次性摘要 Session 在一轮结束时归档，常驻的在被替换时归档，免得占满侧边栏；日志仍保留（DSH 没有删除已存储 Session 的办法） |
| `digest.maxToolCalls` | `12` | 一个摘要 Session 至多调用工具的次数，被拒绝的也算 |
| `digest.agentPreset`、`digest.permissionPreset` | `qq-digest`、`read-only` | 事件 bundle 的 `qq-digest` preset 有人设和两个窄工具 `qq_digest_write`、`qq_group_note`（没有 shell、文件、网页或记忆工具） |
| `digest.workspacePath`、`digest.timeZone`、`digest.timeoutMs` | `/Users/dsh-runtime/work/qq`、`Asia/Shanghai`、`900000` | 工作目录（摘要 Session 在这里，标题是 `QQ: <群名>`）、转录里时间所用的时区，以及等待一次模型调用的期限 |
| `offlineNoticeMs` | `600000` | 协议端这么久连不上、或报告账号下线时（记录器只报告事实，由 DSH 决定告诉 owner 什么；记录器停了属于告警链的事，不走这条通知），经 `ctx.lsyNotifier` 通知 owner；`0` 关闭。每次中断只通知一次：已通知的事记在本插件的 storage domain `lsy_qq`，直到连接恢复才清除，所以中断期间重载或部署不会重复通知 |
| `reconnectQuietMs` | `600000` | 距上一次连接最后存活不到这么久就连上时，不取群列表、不补抓，记录器重启时同样有效（时间记在记录器的 `connection-state.json`，连接期间每分钟刷新）；`0` 表示从不跳过。群列表无论如何每小时最多取一次 |
| `offlineRepeatMs` | `86400000` | 中断持续期间，隔这么久（24 小时）再提醒 owner 一次；`0` 不重复 |
| `settingsUrl` | 未设置 | 事件服务的地址，写进该通知里「设置 → QQ」的旁边；不设置则只提页面名、不带链接 |
| `login.enabled` | `true` | 向扫码入口询问 NapCat 的登录状态（设置里的 QQ 分区） |
| `login.url` | `http://127.0.0.1:3002` | 扫码入口（`napcat.sh door`）的地址；必须在本机或 tailnet 上 |
| `login.timeoutMs` | `5000` | 单次调用扫码入口的期限 |

**哪些改动会重载插件，代价是什么。** 保存现在很便宜：连接归记录器。可热更新字段（`groups`、`backfill.*`、`media.*`、`voice.*`、`asr.enabled`、`retention.textDays`、`honorRecall`、`offlineNoticeMs`、`offlineRepeatMs`、`reconnectQuietMs` 和 `settingsUrl`）直接写进运行中的插件、不重载；其他改动（`url`、`tokenEnv`、`recorder.*`、`digest.*`、`login.*`）会重载本插件，只是重建客户端、重新打开 storage、重建摘要执行器。无论哪种，DSH 都会在启动时和每次取值变化时把设置推给记录器（`PUT /v1/config`），记录器报告了不同的 `configRevision` 时也会重推。记录器只有在 `url` 或 `tokenEnv` 变了才重连 QQ；群、媒体、补抓、保留期等其余设置立即生效，新加进名单的群会补抓。它把设置存在 `recorder-config.json`，所以 DSH 停着时仍按上次的设置录制；第一次启动时先等 DSH 推送设置再连接。设置 → QQ 的「全部设置」卡片会列出每个字段（记录的群有自己的卡片，排在它上面）。补取历史、图片和语音的开关由 owner 在那里切换，都属于可热更新字段。

补抓的消息只存文字：不下载图片和语音（对应行会注明），实时消息不受影响。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsy-qq)是全部可接受字段的完整来源。

**QQ 把账号踢下线时**，在 DSH 页面重新扫码：**设置 → QQ**（[`@deepseek-ai/dsh-lsy-qq-login`](../lsy-qq-login/README.zh.md)）显示连接状态、NapCat 的登录状态和登录二维码。二维码经*扫码入口*（login door）取得：它是 `napcat.sh start` 在 NapCat 旁边启动的一个小容器（`napcat.sh door` 可单独启动），监听 `127.0.0.1:3002`。NapCat 的 WebUI 能在容器里开 shell、读取 QQ 会话，所以服务用户从不持有它的令牌：令牌由扫码入口持有，它只回答 `GET /v1/login` 和 `POST /v1/login/refresh`，以调用方带来的 OneBot token 作为凭证，并且只转交类型明确、长度受限的字段（二维码链接必须是 https 的 `*.qq.com` 地址才放行）。记录器读取扫码入口，DSH 向记录器询问（`loginStatus()` 和 `refreshLogin()`）；`connectionStatus()` 是记录器最近一次的状态，DSH 用不了记录器时则是 `recorder-down` 或 `protocol-mismatch`（设置页和总览卡片都会显示，八种语言齐全），并且在扫码入口说 NapCat 已登录、而记录器还在退避等待时立刻重连。**记录器（用户 `dsh-runtime`）对 NapCat 能做什么、不能做什么**：它持有 OneBot token（`127.0.0.1:3001` 上的 OneBot API，记录器只读取）；通过扫码入口，它能读取 QQ 是否已登录、在需要扫码时读取登录二维码链接，并请求新的二维码（QQ 已登录时以及登录后 10 分钟内拒绝，其余时候每 10 秒一次）。它不能访问 NapCat 的 WebUI（配置、文件、容器里的 shell、退出登录、重启）、docker socket，也不能读保存 QQ 会话的卷。恢复步骤见运行手册第 13 节：[QQ 掉线恢复](../../../lsy/deploy/RUNBOOK.md#qq-recovery)。

摘要是观察者学到的知识，带着来源（`qq-group:<群号>`、摘要编号、日期）；它们不受 30 天限制，`forgetDigests({ groupId?, beforeMs? })`（即 `qq_forget` 工具）按群或日期删除。读取由服务负责：`groupOverview()`、`recentMessages()` 和 `searchMessages()` 是对记录器的请求（记录器停着时以 `RecorderUnavailable` 失败，每个工具都会把它变成给模型的一句「QQ 记录器没有运行」），`digests()` 和群名来自 DSH 自己的 storage，都只对已记录的群作答。`sendGroupMessage(groupId, text)` 一律以 `SendRefused` 拒绝，没有任何地方调用它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

**qq-recorder**（[`src/recorder.ts`](src/recorder.ts)，由 [`lsy/deploy/qq-recorder/main.ts`](../../../lsy/deploy/qq-recorder/main.ts) 打成单个文件、用普通 node 运行）负责摘要之前的一切。`OneBotClient`（[`src/onebot.ts`](src/onebot.ts)）用 Bearer 头带上 token 打开正向 WebSocket，两分钟没有任何数据就丢掉这个 socket（NapCat 每 30 秒一次心跳），按 `echo` 对应 API 调用，并从所有错误里抹掉 token。记录器以 2 秒到 2 分钟翻倍的间隔重连，稳定运行一分钟后重置。每次连上后，它读取登录信息（`get_login_info`）、刷新群列表（`get_group_list`，之后每小时一次），并为每个已记录的群补抓（`get_group_msg_history`，从最新一页向前，直到遇到已存的消息或 `backfill.maxMessages`）。[`src/server.ts`](src/server.ts) 在 unix socket（权限 0600、目录 0700）上用 bearer token 回答 DSH，用 [`src/protocol.ts`](src/protocol.ts) 的 DTO 解析每个请求、检查每个答案；127.0.0.1 上的第二个监听只回答 AMS 用的 `GET /healthz`。[`src/client.ts`](src/client.ts) 是 DSH 这一端：`hello` 握手检查主版本（不一致是 `protocol-mismatch`；次版本较低时，只关闭 `FEATURE_MINOR` 里标了更高次版本的功能），事件流（NDJSON，每 15 秒一次心跳）保持连接状态新鲜，记录器不应答是 `recorder-down` 而不是异常。

一条群消息经解析（[`src/text.ts`](src/text.ts)）成一行文字（`@name`、`[图片]`、`[语音]`、`[文件:name]`、`[卡片:title url]` 等）、被引用的消息 id 和它的媒体。[`src/store.ts`](src/store.ts) 以群号加 QQ 消息 id 为唯一键把它写入 SQLite（`node:sqlite`，WAL），所以重连和补抓不会产生重复行；FTS5 索引使用 trigram 分词器，支持中英文子串检索（不足三个字符的查询退回 `LIKE`）。图片只从 `media.hostSuffixes` 里的域名抓取，走 HTTPS、不跟随重定向、有大小上限、同时两个，存到 `media/<group>/<YYYYMM>/<sha256>.<ext>`（权限 0600；内容相同的字节共用一个文件）。语音消息经 `get_record` 取成 MP3（退而求其次用它的链接），同样保存，开启 `asr.enabled` 时由 lsy-voice 转写，转写文字会追加到消息文字和检索索引里。撤回通知会丢掉该消息的文字、原始片段、媒体行和文件。

每轮 `digest`（每十分钟检查一次，只在记录器有应答、且已接管拆分之前它保存的摘要状态之后才运行）挑出上次摘要已满 `everyHours`、且有 `minMessages` 条新消息的群，把积压切成每份至多 `maxPromptChars` 的转录，对每份在这个群自己的 `qq-digest` preset Session 里跑一轮（权限 `read-only`、配置的模型）。这个 Session 是常驻的（`digest.resident`，默认开启）：每轮恢复同一个，只看到上次摘要之后的消息；preset 会在上下文到模型窗口的四分之一时自己压缩历史（compaction，在事件 bundle 里调参），不让它涨向整个窗口，那样每轮更贵、注意力也更差。每隔 `retention.textDays` 天（默认 30；0 表示不替换）换一个新 Session，新 Session 的第一条 prompt 带上这个群最近五份摘要作为背景，群笔记照常带上，旧 Session 归档（从侧边栏隐藏）而不是删除。恢复不了的 Session 也按同样方式替换。关闭 `digest.resident` 时，每轮在新的一次性 Session 里跑，轮次结束即归档。模型用 `qq_digest_write` 交摘要，用 `qq_group_note` 维护这个群的笔记；两个工具都绑定在这个 Session 和它正在摘要的那一个群上（给别的群的调用、第二份摘要、超过 `digest.maxToolCalls` 的调用、别的 Session 的调用，一律被拒绝），一轮结束时由 runner 带着窗口、模型和 usage 入库。模型若跳过工具、把摘要写在回答里，仍会被保留。它交上来的内容和最终回答先写进 `<DSH_HOME>/lsy-qq-digest/raw/` 再入库；`NO_REPLY` 的回答存一个占位，让游标往前走。每一轮都记日志：工具调用次数、被拒绝的次数、增删的笔记数、Session 被压缩的次数。转录被框成不可信数据，也无法关闭自己的块。

群笔记是 QQ 频道自己的记忆（存在这里，不进 lsy-memory）：这个群常聊什么、黑话和氛围，每群至多 30 条、每条至多 40 字，下一轮以 `#id 内容` 的形式给模型看，方便它删掉某一条。笔记只描述群，不描述个人：过滤器拒绝长数字、邮箱、`@`、成员别名、地址、学校和单位，以及这个群成员出现过的任何名字或群名片。通过后的笔记还要交给共享的守卫（`ctx.lsyGuard.check`，purpose 为 `qq-group-note`，audience 为 `channel`，带上调用的 Session），守卫也必须放行：它拒绝时把对外原因返回给模型，守卫自己出错则拒绝这条笔记。没有这个服务时每条新增笔记都会被拒绝，并给出明确的结果，同时记一条警告（只记一次；删除笔记和摘要不受影响）；记录器给不出该群的成员名单、无法核对时，同样拒绝新增笔记。`groupNotes(groupId)` 读取笔记。`evidenceOf(groupId, messageIds)` 对群里仍保留的每条消息（已记录、未撤回、在 `retention.textDays` 内）返回发送者键、时间和存下来的单行文字，调用方可以据此逐字核验引文。发送者键是由群号和成员加盐哈希得到的 16 位十六进制，在群内稳定、在别的群里不同，从不是 QQ 号。`groupOfSession(sessionId)` 和 `recentTextOf(sessionId)` 让工具从调用它的摘要 Session 取得群号和模型看到的消息（只在该 Session 的这一轮运行期间有答案）。

挂载了 `ctx.lsyEventBus` 时，观察者用 `protectSessions('qq', …)` 认领每个群的常驻摘要 Session，总线的自动归档永远不会归档它；被替换掉的旧一代由摘要自己归档，任一插件重载时认领随之撤回。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | DSH 一侧的服务：配置、客户端的生命周期、设置推送、摘要定时任务、给 owner 的通知和读取 |
| [`src/onebot.ts`](src/onebot.ts) | OneBot v11 客户端和地址检查 |
| [`src/login.ts`](src/login.ts) | 扫码入口的客户端：逐字段检查每个答案 |
| [`src/status.ts`](src/status.ts) | 设置分区用的连接与登录读数类型 |
| [`src/text.ts`](src/text.ts) | 消息片段到文字和媒体 |
| [`src/store.ts`](src/store.ts) | 记录器的 SQLite 表结构、FTS5 检索和保留期；摘要表已冻结，只读一次供接管使用 |
| [`src/media.ts`](src/media.ts) | 地址白名单、有上限的抓取、类型识别、按内容命名的文件 |
| [`src/pii.ts`](src/pii.ts) | 群笔记要过的过滤器：不含个人、号码、地址、学校或成员名 |
| [`src/digest.ts`](src/digest.ts) | 转录切块、摘要提示词，以及经 Session 的模型调用 |
| [`src/protocol.ts`](src/protocol.ts) | 线路协议：zod DTO、版本、路径和 `FEATURE_MINOR` |
| [`src/recorder.ts`](src/recorder.ts) | 记录器：连接、记录、补抓、媒体、保留期、扫码入口和推送来的设置 |
| [`src/server.ts`](src/server.ts) | 记录器的 socket API、事件流和健康监听 |
| [`src/client.ts`](src/client.ts) | DSH 对这套 API 的客户端：握手、设置推送、事件流、`recorder-down` |
| [`src/digest-storage.ts`](src/digest-storage.ts) | DSH 的 storage domain `lsy_qq`：摘要、笔记、常驻 Session、别名盐，以及一次性接管 |
| [`src/address.ts`](src/address.ts) | 两端都用的地址规则（本机或 tailnet） |

这是 fork 本地的包；[`../UPSTREAM.md`](../UPSTREAM.md) 说明 `lsy` 组如何跟踪上游。协议端是 NapCat：它在腾讯自己的 Linux QQ 客户端里加载插件，所以这里没有重新实现任何 QQ 协议。LLBot 的 macOS CLI 被否决，因为它用闭源原生模块给数据包签名，而这些模块会调用厂商的 token 服务；官方 QQ 开放平台机器人先做过又放弃了，因为机器人在群里只能看到 @ 它的消息，不能作为一个读取全部消息的成员。数据留在这台机器上（记录器的数据目录和 DSH 的 storage）；离开这里的文字只有发给摘要模型的转录和 agent 经工具读到的内容。

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

每份转录在这个群的 Session 里是一条用户 prompt（新 Session 的第一条还带着以前的摘要，放在 `<qq_group_history trust="derived">` 里）：一段英文指令，点名这个群、要写的小节标题（话题、结论与事实、术语与梗、常见问题、链接与资料；只有开启 `digest.profiles` 才加“成员观点与专长”）和 1500 字上限，然后是 `<qq_group_messages trust="untrusted">` 里的转录，每条消息一行，格式为 `[MM-DD HH:mm] 群友#a3f9 ↳reply: text`（成员默认是别名；关闭 `digest.aliasMembers` 时是名字加 QQ 号末四位）。消息里告诉模型要传给两个工具的群号，并把这个群的笔记放在 `<qq_group_notes trust="derived">` 里给它看。preset 的人设说明聊天内容是数据、它唯一的工具只写这个群的摘要和笔记。摘要就是 `qq_digest_write` 收到的内容（没有则取最终回答）；`NO_REPLY` 表示没有值得保留的内容。

#### Token 影响

每次调用至多 `maxPromptChars` 个字符的转录加约 300 token 的指令，回答至多约 1500 字；每个群每轮至多 `maxCallsPerRound` 次调用，默认每个群每天一轮。每步 usage 随摘要保存。

#### KV Cache 影响

一个群的各轮共用一个 Session，人设、工具和早先的轮次构成稳定的前缀，provider 可以缓存；上下文到窗口的四分之一时，压缩会改写最旧的部分。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **保留期**——原始消息和下载在 30 天后删除；摘要里或消息文字里引用的名字，仍可能带着成员自己写的关于自己的信息。
- **登录二维码由扫码入口提供**——扫码入口（`napcat.sh door`）没在运行时，设置页显示不出二维码，并会说明怎么启动它；协议端连接本身不依赖它。
- **记录器是第二个进程**——qq-recorder 停着时什么都不录（它一停，与 QQ 的连接也断），设置 → QQ 和工具都会如实说明；AMS 会重启它，反复失败时升级到告警链。记录器重新部署期间到达的消息和任何一次重连一样会丢（静默重连规则在 `reconnectQuietMs` 内跳过补抓）。部署顺序是先记录器、后 DSH；只回滚 DSH 是安全的，因为协议只做加法。
- **非官方客户端，有封号风险**——NapCat 不是官方机器人：腾讯可能让账号下线或限制它。请用备用小号、保持只读，不要在很多地方登录。
- **只能看账号所在的群**——得有人先把这个号拉进每个群。
- **文字、图片和语音**——视频和群文件只记录元数据；合并转发的聊天记录记为 `[合并转发]`。
- **图片链接会过期**——下载失败或被跳过的图片只剩占位。
- **语音依赖协议端的解码器**——`get_record` 必须以 base64 返回音频，否则只存原始链接、不转写。
- **群聊原文留在 Session 日志里**——DSH 没有删除已存储 Session 的 API，所以摘要 Session 读过的转录，在本包自己的存储按 `retention.textDays` 删除消息之后，仍留在它的日志里（被替换的 Session 和一次性 Session 的旧日志也留着，只是归档了）；压缩也不会把它们删掉。清理要在 Mac mini 上离线做，这里没有任何代码做这件事。
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
