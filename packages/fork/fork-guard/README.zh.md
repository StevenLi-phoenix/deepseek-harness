---
description: "给别人能读到的文字用的统一校验器：正则模式、金丝雀字符串、与 owner 记忆的重合、再加一个模型，各层都能单独拒绝，任何一层跑不起来也拒绝。其他插件在写入共享或公开文字之前调用 ctx.forkGuard.check。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-guard

[English](README.md) | 中文

## 概述

让 owner 的私人生活不出现在 agent 写给别人看的任何文字里。凡是会存下或发出陌生人能读到的文字的插件（人设更新、说话风格笔记、QQ 群笔记、B 站频道笔记），都问同一个校验器 `ctx.forkGuard.check(text, { purpose, audience })`，不再各自维护一堆正则。回答要么是 `{ ok: true }`，要么是带规则名和一句通用理由的拒绝，理由里不会复述原文，可以直接交还给写这段文字的模型。四层按顺序运行，哪一层跑不起来同样算拒绝。

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

在根上挂一次，fork event bundle 已经挂好。服务只在 Host 里用，不给任何 agent 暴露工具。

```yaml
- id: fork-guard
  name: '@deepseek-ai/dsh-fork-guard'
  config:
    extraCanaries: ['a honeypot token']   # in the profile patch, not in the public bundle
```

```ts
const verdict = await ctx.forkGuard.check(text, { purpose: 'persona_update', audience: 'public', sessionId })
if (!verdict.ok) return `refused (${verdict.rule}): ${verdict.publicReason}`
```

`purpose` 是简短的标识符（`persona_update`、`style_note`、`qq_group_note`、`bili_channel_note`，小写字母、数字、`_`、`.`、`-`，最多 40 个字符）。`audience` 为 `public` 表示任何人都能读，`channel` 表示某个 QQ 群或 B 站账号的读者。两者只差一点：模型层对 `channel` 可以关，对 `public` 永远关不掉。

| 规则 | 层 | 含义 |
|---|---|---|
| `pattern.phone`、`pattern.email`、`pattern.id_number`、`pattern.bank_card`、`pattern.contact`、`pattern.url_token`、`pattern.long_number`、`pattern.mention`、`pattern.address`、`pattern.os_path`、`pattern.link` | 正则模式 | 手机号（中国、美国）、邮箱、中国身份证号、通过 Luhn 校验的银行卡号、带标签的联系方式（`QQ: abc123`、`微信 xyz`）、带 token 或账号 id 的链接、连续五位以上数字、`@`、地址、含用户名的文件路径、任何链接 |
| `canary` | 金丝雀 | 文字里含有金丝雀文件或 `extraCanaries` 中的字符串 |
| `memory_overlap` | 记忆 | 文字重复了 owner 记忆里一段有辨识度的片段 |
| `llm.<类别>`、`llm.pii` | 模型 | 模型发现了私人信息（`real_name`、`school_employer`、`location`、`contact_account`、`health`、`finance`、`family`、`private_message`、`other`） |
| `llm.unsure`、`llm.unparseable`、`llm.unavailable` | 模型 | 模型拿不准、答得不符合协议，或在时限内联系不上 |
| `canary.unavailable`、`memory.unavailable`、`pattern.error`、`guard.error` | 任一层 | 某一层没能运行 |
| `guard.bad_input`、`guard.too_long` | 输入 | purpose 为空或格式不对、audience 未知，或文字超过 `maxChars` |

| 字段 | 默认值 | 含义 |
|---|---|---|
| `layers.patterns`、`layers.canary`、`layers.memory`、`layers.llm` | `true` | 哪些层运行；`layers.llm: false` 对 `public` 无效（日志里一条警告） |
| `blockLinks` | `true` | 拒绝任何链接；`false` 时只拒绝带 token 或账号 id 的链接 |
| `canaryFile` | `<DSH_HOME>/fork-guard/canaries.txt` | 每行一个字符串，`#` 开头为注释，文件变化后自动重新加载；文件不存在等于空列表 |
| `extraCanaries` | `[]` | 写在配置里的字符串，叠加在文件之上 |
| `memoryFile` | `<DSH_HOME>/fork-memory/memory.jsonl` | 比对用的记忆文件（条目和待批准的写入）；文件不存在则没有重合 |
| `provider`、`model` | profile 默认 | 模型层的路由，必须成对设置；不设则用 `ctx.agentDefaultModel`，即 event profile 选的便宜路由 |
| `timeoutMs`、`maxOutputTokens` | `20000`、`400` | 一次模型调用的时限和输出上限 |
| `maxChars` | `20000` | 校验的最长文字 |
| `cacheHours` | `24` | 同一文字、purpose、audience 的模型判定复用多少小时 |
| `dir`、`rawRetentionDays` | `<DSH_HOME>/fork-guard`、`14` | `canaries.txt` 和 `raw/` 所在目录，以及模型原始响应保留天数 |

金丝雀比对不分大小写、全半角、空格和标点（`BSV-Honeypot-7F3A91` 能命中 `bsv_honeypot_7f3a91`）。短于三个字符的金丝雀会被忽略，含中日韩字符的短于两个字符也忽略，否则会误伤无关文字。

`ctx.forkGuard.health()` 返回最近 24 小时的计数（校验次数、拒绝次数、按规则的拒绝次数）、最近一次层故障（消息截断到 200 个字符）和最近一次校验的时间，从不含任何文字。每次校验记一行日志：purpose、audience、结论、规则、文字 SHA-256 的前 12 位十六进制、毫秒数、缓存命中与否。文字和金丝雀都不会写进日志。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`check` 从不 reject。它先校验输入，再按顺序运行已启用的层，返回第一个拒绝。正则模式是对 NFKC 折叠后文字的纯函数；被空格或短横线隔开的数字当作一个号码。金丝雀层把文字压成只剩字母和数字，再与压缩后的每个金丝雀比较。记忆层调用 [fork-memory](../fork-memory/README.zh.md) 的 `MemoryStore.containsSpanOf`，它读取记忆文件和待批准的写入，只回答布尔值：共享片段指连续六个 CJK 字符，或者拉丁文字去掉一小撮虚词后连续三个词。文字短到放不下一个片段时跳过读文件。

模型层通过 `ctx.llm.stream` 发一个请求：带版本号的系统 prompt（`GUARD_PROMPT_VERSION`）、purpose 和 audience，以及放在 `<text_under_review>` 标签里的文字，其中 `<` 和 `>` 换成全角形式，文字无法自己闭合围栏。请求没有工具、没有 Session、没有记忆。路由是显式的 `provider` 和 `model`（取模型提供的最轻推理档位），或 `ctx.agentDefaultModel` 的选择。答案必须是一个 JSON 对象 `{"label": "clear" | "pii" | "unsure", "categories": [...]}`，其他一律 `llm.unparseable`。原始响应在解析之前写入 `<dir>/raw/<YYYY-MM-DD>/<id>.json`（权限 0600，只记文字的哈希，不记文字），调用失败时拿到的部分响应也保留。超过 `rawRetentionDays` 的日期目录在启动时删除，之后每次保存后最多每小时清一次。

只缓存模型层，键是文字、purpose、audience 和 prompt 版本的 SHA-256，存在内存里，保留 `cacheHours`；便宜层的拒绝重复起来没有成本，新加的金丝雀或记忆条目立即生效。同时到达的相同文字共用一次调用。模型报错或超时不缓存。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件、配置、`ctx.forkGuard` |
| [`src/service.ts`](src/service.ts) | `GuardService`：层的顺序、缓存、健康计数、日志 |
| [`src/patterns.ts`](src/patterns.ts) | 确定性的一层；`LINK`、`MENTION`、`LONG_NUMBER` 就是 `fork-style` 行过滤器用的表达式 |
| [`src/canary.ts`](src/canary.ts) | 金丝雀文件和配置里的字符串 |
| [`src/classifier.ts`](src/classifier.ts) | prompt、答案解析、原始响应存储 |
| [`src/model.ts`](src/model.ts) | 经由 LLM 服务发起的模型调用 |

这是 fork 本地的包，见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Owner 记忆](../fork-memory/README.zh.md) — 记忆层比对的事实来源
- [说话风格](../fork-style/README.zh.md) — 本包共享其正则的行过滤器
- [QQ 观察者](../fork-qq/README.zh.md) — 它的群笔记过滤器是正则的另一个来源

-----

<a id="model-experience"></a>
## 模型体验

对写这段文字的 agent 没有影响：guard 不注册工具，也不往它们的请求里加东西；写入方的插件转交拒绝时，它只会看到规则名和一句通用理由。审查本身是另一个独立的一次性请求。

#### KV Cache 影响

对主 agent 没有影响。审查请求的系统 prompt 固定，提供方可以跨多次校验复用；模型层的缓存避免对同一段文字重复发请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **是否调用由调用方决定** — guard 只校验交给它的文字；不调用它就写文字的插件不在保护范围内。
- **词表加模型，不是证明** — 正则抓不到用文字拼出来的数字和改写过的事实；模型层是兜底，两个方向都可能判错。被拒绝的文字只需要重写一次。
- **短金丝雀被跳过** — 单字姓名无法匹配，否则会误伤无关文字。
- **常见中文短语可能重合** — 与某条记忆共享六个字的片段就会被拒绝，即使这句话本身无害。
- **缓存在内存里** — 重启后同一段文字会再调用一次模型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作背景：未决的方向和给维护者的备注。已发布的行为和已接受的理由见上面各节、包代码和链接的 Agent Notes。

- `fork-style` 和 `fork-qq` 仍保留各自的过滤器，它们在各自的改动里改为调用 `ctx.forkGuard.check`。
- 分类器设计沿用 bili-svc 的 PII 闸门：两层 fail-closed、带版本的 prompt、枚举标签、先落盘原始响应再解析。

</details>
