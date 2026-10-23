---
description: "lsy 事件 agent 的跨 Session 主人记忆：Host 在每个根 Session 前放入的 JSONL 文件，memory_search/memory_save/memory_forget 工具，以及 claude.ai 记忆导出的导入器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-memory

[English](README.md) | 中文

## 概述

让 agent 跨 Session 记住主人。Host 把条目保存在 `<DSH_HOME>/lsy-memory/memory.jsonl`，并由自己放到模型面前：每个根 Session 的第一个请求以及压缩后的第一个请求都会带上记忆块，其中指令和偏好是全文，职业和项目条目只列开头几个字，身份条目只给数量，因此关于人物和账号的细节只在搜索时才离开 Host。agent 用 `memory_search` 读取条目，用 `memory_save` 和 `memory_forget` 写入。claude.ai 的记忆导出可以原样导入。

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

把下面这一行加到需要记忆的 agent preset 的插件列表里。lsy event profile 把它挂在 `unattended` preset 中，微信聊天 Session 和 watch 启动的 Session 都使用这个 preset。

```yaml
- id: lsy-memory
  name: '@deepseek-ai/dsh-lsy-memory'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `file` | `<DSH_HOME>/lsy-memory/memory.jsonl` | 记忆文件 |
| `maxBytes` | `65536` | 记忆块上限；放不下的条目在末行计数，仍可搜索 |

每个条目是一行文本，带 id、分类和最后一次写入的日期：

| 分类 | 在记忆块中 | 内容 |
|---|---|---|
| `instructions` | 全文 | 主人希望 agent 怎么做事 |
| `preferences` | 全文 | 口味、观点、风格 |
| `identity` | 只给数量 | 主人是谁：人物、家人、学校、账号 |
| `career` | 开头几个字 | 工作与求职 |
| `projects` | 开头几个字 | 主人在做或在研究的东西 |

导入 claude.ai 记忆导出（`## <n>. <Category>` 标题下的 `[YYYY-MM-DD] - text` 行）时，以服务用户身份运行导入；它保留导出里的日期，跳过已有条目，只打印数量：

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node \
  /Users/Shared/lsy-dsh/current/lsy/deploy/memory-import.mjs < export.md
```

加 `--dry-run` 只计数。下一个 Session 就能看到结果，不需要重启。文件是普通 JSONL（权限 600），可以手工编辑：不是合法条目的行会让注入和所有写入停下，直到修好为止，而不会被丢掉。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个 `agent/pre-step` 监听器在以下条件同时满足时加入记忆块：这一步提出了消息，Session 不属于 subagent（`header.origin === 'subagent'`），并且 Session 当前可见的 surface 节点里没有 `lsy-memory` 消息。它读取文件、渲染记忆块（`render.ts`），并放在已认领的 prompt 之后，与工作区指令的位置相同。记忆块是普通的带来源 `user/message`（`form: 'instructions'`），因此随 Session 重放和恢复；压缩把它替换掉之后，下一步会加入一个新的，包含期间保存的内容。文件读不了时记一条日志，请求照常进行，只是没有记忆。

工具调用 `MemoryStore`，它校验模型发来的一切：分类必须属于固定集合，id 必须是六位十六进制，文本折叠成一行且最多 2000 个字符，总数最多 1000 条。每次修改都在按路径的锁内重新读取文件，经临时文件和 `rename` 替换，因此并发的 Session 和两次写入之间的手工编辑都会保留。保存同一分类里已存在的文本时返回已有条目。日期由 Host 填写。日志只记 id、分类和长度，从不记条目文本。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 注入与三个工具 |
| [`src/store.ts`](src/store.ts) | JSONL 存储：列出、保存、遗忘、导入、搜索 |
| [`src/render.ts`](src/render.ts) | 记忆块与字节预算 |
| [`src/entries.ts`](src/entries.ts) | 条目类型、分类、校验 |
| [`src/export.ts`](src/export.ts) | claude.ai 导出解析器 |
| [`src/cli.ts`](src/cli.ts) | `memory-import`（通过 [`lsy/deploy/memory-import.mjs`](../../../lsy/deploy/memory-import.mjs) 运行） |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [工作区指令](../../context/agent-instructions/README.zh.md)——`AGENTS.md` 文件采用的同一种持久上下文模式
- [第三方记忆 MCP 服务](../../../docs/user/guide/mcp-memory.zh.md)——上游的替代方案，由模型决定何时回忆

-----

<a id="model-experience"></a>
## 模型体验

### 记忆块

#### 模型看到的内容

每个根 Session 一条 user 角色消息，包在 `<system-reminder>` 中：三行说明，要求遵循指令和偏好；在依赖只列开头或只给数量的条目之前，或主人的背景可能相关时，调用 `memory_search`（中英文都搜）；主人要求记住、更正或忘掉某事时，在同一轮调用 `memory_save` 或 `memory_forget`。随后是 `## Instructions` 和 `## Preferences`，格式为 `- [date] (id) text`；`## Identity` 只有一行 `N entries, not listed; memory_search finds them.`；`## Career`、`## Projects` 的格式为 `- id · <前 80 个字符>…`；预算用完时以 `(N more entries did not fit; memory_search finds them.)` 结尾。

#### Token 影响

记忆块的大小，最多 `maxBytes`，每个根 Session 一次，每次压缩后再一次；主人的记忆（170 条）渲染后约 24 KB。subagent 不承担。

#### KV Cache 影响

只追加：记忆块在第一个请求时进入可复用前缀之后，Session 中途记忆变化时不会重写，因此后续请求可以复用。

### 记忆工具

#### 模型看到的内容

只要 Agent 的 preset 挂载了这个包，就有三个工具 schema：`memory_search`（`query`，可选 `category` 和 `limit`）、`memory_save`（`text`、`category`，可选替换用的 `id`）、`memory_forget`（`id`）。结果是一个 JSON 文本块：`{ "entries": [{ id, category, date, text }], "more" }`、`{ "outcome": "added" | "replaced" | "unchanged", "entry" }`、`{ "forgot": entry }`，或 `{ "error": "<code>", "message" }`，错误码有 `invalid_text`、`invalid_category`、`invalid_id`、`not_found`、`full`、`corrupt`。

#### Token 影响

挂载该包的 preset 下，Agent 的每个请求都有固定的 schema 开销；一次搜索的开销是返回的条目，最多 50 条。

#### KV Cache 影响

工具定义不变时前缀稳定；结果追加在可复用前缀之后。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **子串搜索**——没有 embedding 或同义词；中文词找不到英文条目，所以记忆块要求模型中英文都搜。
- **其他条目由模型决定是否回忆**——指令和偏好总会送达；职业、项目和身份条目的细节只在模型搜索时才出现。
- **一个主人，一个文件**——该 preset 下的所有 Session 共享同一份记忆。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 结构参照 claude.ai 的记忆（分类、带日期的单行事实）和 Claude Code 的自动记忆（常驻部分加按需细节）；索引由 Host 维护，而不是模型。

</details>
