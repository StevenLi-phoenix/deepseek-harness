---
description: "主 agent 的完整性监控：操控它的那些文件的摘要，变化时用微信点名告诉 owner（从不给内容），日志里记每个 Session 系统 prompt 的哈希，并按天统计人格禁用口头禅的出现次数。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-integrity

[English](README.md) | 中文

## 概述

如果有人往 `AGENTS.md`、某个 skill、profile patch 或定时任务里塞一行话，agent 就会在没人决定的情况下变样。这个包记下这些文件的摘要，变了就在微信上点名告诉 owner 是哪一个——只给名字，不给内容，合并发送，一天最多几条。它还在日志里记录每个 Session 系统 prompt 的哈希，改过人格就能在日志里看出来；并统计 owner 收到的回答里出现人格禁用口头禅的次数（只有计数），模型的口头禅卷土重来时，趋势一目了然。

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

挂在根作用域，所在进程里还要有通知器（`ctx.lsyNotifier`，来自 [`lsy-wechat`](../lsy-wechat/README.zh.md)）。lsy 事件 profile 在这里列出各 Session 的工作区。

```yaml
- id: lsy-integrity
  name: '@deepseek-ai/dsh-lsy-integrity'
  config:
    workspaces:
      - /Users/dsh-runtime/me
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 关闭整个监控 |
| `workspaces` | `[]` | 被监控 `AGENTS.md`、`CLAUDE.md`、`CLAUDE.local.md`、`.dsh/skills`、`.agents/skills` 的目录 |
| `intervalSec` | `300` | 两次扫描的间隔（秒） |
| `notify` | `true` | 在微信上告诉 owner；`false` 只记日志 |
| `minGapSec` | `1800` | 两条通知之间至少隔多少秒；更早到来的变化等着，并并入下一条 |
| `noticesPerDay` | `6` | 一天最多几条通知 |
| `ticPresets` | `unattended`、`bili` | 检查回答里有没有人格禁用口头禅的 preset |
| `stateDir` | `<DSH_HOME>/lsy-integrity` | 基线、人格哈希和计数的存放处 |
| `memoryFile` | `<DSH_HOME>/lsy-memory/memory.jsonl` | 摘要要与记忆历史对照的记忆文件 |

一直在监控的有：家目录层 patch `<DSH_HOME>/cordis.patch.yml`、owner 层 `<DSH_HOME>/profiles/event/cordis.patch.yml`、`<DSH_HOME>/AGENTS.md` 及同类文件、`<DSH_HOME>/skills`、`~/.agents/skills`、`storages/schedule.json` 里定时任务的定义（不含触发历史），以及记忆文件。第一次扫描静默写下 `baseline.json`。此后目标被修改、新出现或被删除，就发一条 `🔐 完整性：N 处被改动（不显示内容）`，并把它记为新的基线。记忆文件一天里经由记忆工具不停地变，所以拿它与记忆历史最后一次记录的 SHA-256 对照；只有不是工具所做的变化才会报告。

`<stateDir>/tics.json` 按天记录：owner 收到几条回答、几条含禁用口头禅，以及每条口头禅的计数（用它在人格清单里的序号）。`persona.json` 记录每个 preset 最近一次的系统 prompt 哈希。

把家目录层 patch 设为不可变（`chown root:wheel` 加 `chflags uchg`）是运维的部署步骤，不在这里做：现在 agent 就是以拥有该文件的账号运行的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`scan.ts` 给每个目标算摘要：文件用字节的 SHA-256（超过 4 MiB 的文件用大小和修改时间），目录用排序后的相对路径加文件摘要（跳过 `node_modules` 和 `.git`，最多 2000 个文件），定时任务用任务 id 加每个任务定义的摘要。目标不存在和读不了各有自己的值，所以出现、消失和权限问题都算变化。`index.ts` 每 `intervalSec` 秒与基线比对；被间隔或每日上限压住的变化不进基线，下一次扫描会再次发现，被压住的变化就这样合并。发送失败会重试。

Session 钩子监听 `session/event`。`system/message` 被哈希（SHA-256 的前 12 位十六进制）并连同 Session 的 preset 记入日志；同一个 preset 的哈希变了，会记一条警告，升级或换模型后出现是正常的（人格里写了模型名），仅此而已。被检查的 preset 在 `turn/end` 时，拿回合最后一条 assistant 消息与 `src/tics.ts` 匹配；`NO_REPLY` 的回合跳过。`tics.ts` 是把人格黑名单抄出来的一份；有一个测试读取 bundle，两份在任一个人格 preset 里不一致就失败。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件：扫描循环、通知、系统 prompt 哈希、口头禅计数 |
| [`src/scan.ts`](src/scan.ts) | 监控目标及其摘要 |
| [`src/tics.ts`](src/tics.ts) | 禁用口头禅及其匹配器 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Owner 记忆](../lsy-memory/README.zh.md)——记忆检查读取其历史里的哈希
- [回合来源](../lsy-taint/README.zh.md)——owner 没有独自发起的回合适用的规则

-----

<a id="model-experience"></a>
## 模型体验

无，这个包读文件和 Session 事件，把计数和摘要写在自己的目录下，并通知 owner；不会往任何模型请求里添加内容。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。微信通道会把发出的通知作为提示复制进对话 Session 供它下一轮使用，这部分在可复用前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **摘要只能说变了，不能说变了什么**——通知分不清合法的修改（owner 在 Web UI 里保存设置）和被植入的修改，由 owner 根据名字判断。
- **轮询**——变化在 `intervalSec` 之内发现，不是立刻；两次扫描之间改了又改回去，看不到。
- **人格哈希是整个系统 prompt**——模型名、工具、指引变了它也会变，不只是人格。
- **只看列出的地方**——不在 `workspaces` 里的目录中的 skill 或指令文件不被监控。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 两次写入之间对记忆文件的手工修改，只有恰好有一次扫描落在两者之间才能发现；在下一次写入时往记忆历史里记一条 `external edit` 标记，就能让它变成持久证据。

</details>
