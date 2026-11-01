---
description: "管理事件服务运行内容的设置分区：每个已集成服务的健康总览，事件总线订阅和定时提醒的暂停、恢复、删除与新建，以及服务账号的 Claude Code 会话和语音试听。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-console

[English](README.md) | 中文

## 概述

在浏览器里管理事件服务，不用再开 SSH。**设置 → 服务总览**为每个已集成的服务显示一张健康卡片，带一个跳到该服务自己分区的“管理”链接。**设置 → 订阅与监控**列出事件总线订阅和定时提醒，可以暂停、恢复、删除或新建；来自配置的保持只读。**设置 → Claude Code 与语音**列出、启动和停止服务账号的 Claude Code 会话，并在你的浏览器里播放一句语音试听。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。它需要设置外壳（`@deepseek-ai/dsh-client-ui-settings-general`，声明了 `settings.section` 列表），Host 上还需要 `connection` 服务，Web bundles 都已组合好。其余服务都是可选的：没挂载的服务，它的卡片写“未安装”（说话风格页 `ctx.lsyStyle` 在发布前就是其中之一）。Claude Code 需要 [`lsy-cc-admin`](../lsy-cc-admin/README.zh.md)，event bundle 把它挂在本包旁边。

```yaml
- id: lsy-console
  name: '@deepseek-ai/dsh-lsy-console'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bili.url` | `http://127.0.0.1:8097` | bili-svc，探测 `<url>/healthz` |
| `ams.url` | `http://127.0.0.1:18090` | AMS 接收器；任何低于 500 的应答都算可达。留空则不显示它的卡片 |
| `probeTimeoutMs` | `2000` | 每次探测的期限 |
| `subscriptions.*` | 与 `watch_create` 相同 | `workspacePath`、`agentPreset`、`permissionPreset`、`coalesceSeconds`、`notifyMaxPerHour`、`sessionMaxPerHour`：用表单建的订阅按什么运行 |
| `previewText` | 一句简短的中文 | 语音试听说的那句话（不超过语音服务的 `tts.maxChars`） |

**总览。**分区打开且页面可见时，卡片每 10 秒刷新一次。只有目标分区已注册时，卡片才会链接到 `bili`、`lsy-qq`、`lsy-wechat`、`lsy-style`、`lsy-sysmon`、`lsy-subscriptions`、`lsy-agents` 或 `account`。服务想给自己的卡片补充细节，可以提供一个可选的 `health()`，返回 `{ state: 'ok' | 'warn' | 'down', detail? }`；`bili`、`lsyQq` 和 `lsyNotifier` 有它就按它读。

**订阅。**在总线配置里定义的订阅显示“来自配置”，没有按钮。`watch_create` 或表单建的订阅可以暂停（不再匹配新事件，已在排队的事件保留）、恢复，或在第二次点击后删除；删除监视时也会停掉它的仓库轮询，和 `watch_delete` 一致。表单需要名称、来源/类型/对象 glob（至少一项）、通知或会话模式，会话模式还要任务说明；会话订阅按配置的预设和工作区运行。定时提醒（`schedule_create`）可以暂停、恢复和删除；改时间请对智能体说。

**Claude Code 与语音。**这里的会话属于 `dsh-runtime` 自己的 Claude Code，不是你本人的。页面只能停止桥在自己 tmux 服务器里启动的会话，最多同时启动 `lsy-cc-admin` 的 `maxSessions`（3）个。第一条任务会作为 Claude Code 的 prompt 参数，所以从这里启动的会话把它当作你本人的话。语音卡片显示朗读和听写是否有应答，试听按钮合成固定的一句话并在浏览器里播放，不发往任何频道。听写属于配置，所以卡片只给出开启它的补丁，保持只读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/lsy.overview`、`GET`/`POST /api/lsy.subscriptions` 和 `GET`/`POST /api/lsy.agents`，因此受 `/api` 的登录校验保护。POST 必须是 `application/json`（跨站表单发不出它），不超过 64 KiB，并用 schemastery 校验；拒绝时返回 `{ error, detail? }`，带稳定的错误码和字段路径，从不带值。每个动作记一行日志：名称、目标、结果和耗时（`subscription.delete octo-tags -> ok (3 ms)`），从不记 token、事件、任务或试听的那句话。

总览并行读取每张卡片。每个 HTTP 探测有 `probeTimeoutMs`，整张卡片的上限是它的两倍加半秒，所以卡死的服务只花一个期限并显示为红色；抛错的卡片显示红色，日志只记错误类型。卡片带的是状态和事实（计数、名称、秒数），从不带 URL、密钥或消息正文。构建标识取入口文件所在的 `builds.noindex/<sha>` 目录和它上面 `@deepseek-ai/dsh` 包的版本。Claude Code 的登录状态：`~/.claude/.credentials.json` 非空为 `full`，OAuth token 文件非空为 `token`，否则 `none`；这些文件只做 `stat`。

订阅用总线自己的 API：`listSubscriptions()`、`batches()`（算触发次数）、`subscribe()`、`unsubscribe()` 和 `setPaused()`；提醒用 `ctx.schedule.catalog()` 和 `edit()`（`active`、`delete`）。浏览器立刻移除或翻转一行，Host 的回答再替换它；被拒绝时把那一行放回去并说明原因。`monitor_start` 启动的监控属于启动它的对话，登记在 Host 够不到的预设作用域里，所以页面只说明去哪里管理，不列出它们。

Claude Code 会话来自 `ctx.lsyClaudeCode`（[`lsy-cc-admin`](../lsy-cc-admin/README.zh.md)），通过一个很小的结构类型读取，所以这个带浏览器部分的包不会运行时导入任何对等包的值。语音和总线的错误同理，Host 部分按名字识别它们。

浏览器部分通过 `ctx.slots.inject` 注册三个 `settings.section` 条目（`lsy-overview` 顺序 35、`lsy-subscriptions` 58、`lsy-agents` 60）。“管理”链接调用设置外壳交给每个分区的 `select(id)`（与 `close` 并列），并且只在目标分区已注册时显示。模型路由卡片在浏览器里由 `api/lsy.balance` 构建。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：三个路由、状态码与错误应答 |
| [`src/overview.ts`](src/overview.ts) | 各卡片与它们带期限的探测 |
| [`src/subscriptions.ts`](src/subscriptions.ts) | 总线与定时服务上的列表与动作 |
| [`src/agents.ts`](src/agents.ts) | Claude Code 与语音卡片、启动、停止和试听 |
| [`src/claude-code.ts`](src/claude-code.ts) | 本页用到的 `ctx.lsyClaudeCode` 的形状 |
| [`src/request.ts`](src/request.ts)、[`src/log.ts`](src/log.ts)、[`src/probe.ts`](src/probe.ts)、[`src/build-info.ts`](src/build-info.ts) | 请求体解析与拒绝、动作日志、期限、构建标识 |
| [`src/views.ts`](src/views.ts) | 两部分共用的类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、三个分区注册、试听播放器 |
| [`src/client/resource.ts`](src/client/resource.ts) | store、带乐观动作的 loader，以及感知页面可见性的轮询 |
| [`src/client/Overview.tsx`](src/client/Overview.tsx)、[`Subscriptions.tsx`](src/client/Subscriptions.tsx)、[`Agents.tsx`](src/client/Agents.tsx) | 三个分区 |
| [`src/client/cards.ts`](src/client/cards.ts)、[`balance.ts`](src/client/balance.ts)、[`subs.ts`](src/client/subs.ts) | 卡片文字、模型路由卡片、表单规则 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [设置领域](../../client/ui-settings/README.zh.md)——这些分区所填的 `settings.section` 插槽
- [lsy-event-bus](../lsy-event-bus/README.zh.md)——订阅与 `setPaused()`
- [lsy-cc-admin](../lsy-cc-admin/README.zh.md)——Claude Code 会话服务
- [lsy-cc-bridge](../lsy-cc-bridge/README.zh.md)——会话所在的启动脚本与工具
- [lsy-voice](../lsy-voice/README.zh.md)——`describe()` 与语音服务
- [lsy-sysmon](../lsy-sysmon/README.zh.md)——这些分区的卡片与轮询所沿用的页面

-----

<a id="model-experience"></a>
## 模型体验

无，这些分区属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **从这里启动的会话不是智能体的**——用表单建的订阅启动的无人值守会话与 `watch_create` 建的相同；从这里启动的 Claude Code 会话属于服务账号，智能体只有在它主动发消息时才会收到消息。
- **不列出监控**——`monitor_start` 的登记属于各个预设挂载；请让启动它的对话执行 `monitor_list` 或 `monitor_stop`。
- **触发次数受保留数量限制**——次数是总线还保留着的批次数（`retainBatches`，默认 1000），“上次触发”是其中最新的一批。
- **听写只读**——它属于配置，而补丁条目的 `config` 会替换整个条目，所以卡片展示补丁而不是替你保存。
- **微信和说话风格的卡片在它们报告健康前信息很少**——服务可以通过增加 `health()` 报告更多；QQ 卡片有 `connectionStatus()` 和 `recordedGroups()` 时就读它们。
- **试听要等语音模型**——闲置后的第一句在 feiyu 上约需 45 秒；同一时间只跑一个试听。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- `select` 属性是对 `ui-settings-general` 和插槽契约的 fork 修改（见 `packages/lsy/UPSTREAM.md`）；没有分区注册的 id 会显示外壳的第一个分区，所以链接先做检查。
- 触达监控需要 `unattended` 预设往隔离域里发布一个服务，而预设注册表的挂载审计只允许按挂载逐个这样做。

</details>
