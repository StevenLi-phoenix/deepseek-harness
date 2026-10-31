---
description: "只读工具 qq_groups、qq_digest、qq_recent 和 qq_search：agent 询问已记录的 QQ 群最近在聊什么，每个回答都被包成不可信数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-qq

[English](README.md) | 中文

## 概述

问你的 agent 某个 QQ 群最近在聊什么。它会读观察者写的摘要、某个群的最新消息，或在所有已记录群里检索，并据此回答。这些工具只读：不能发送、加入或改动 QQ 上的任何东西，而且只有观察者名单上的群才会回答。

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

把这一行加进应该读 QQ 的 agent preset 的插件列表，且该进程同时挂载 [`@deepseek-ai/dsh-lsy-qq`](../lsy-qq/README.zh.md)。lsy 事件 profile 把它挂在 `unattended` preset（微信主 agent）里。

```yaml
- id: lsy-tool-qq
  name: '@deepseek-ai/dsh-lsy-tool-qq'
```

这个插件没有配置；群、数据和摘要都属于 `lsy-qq`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个工具调用 `ctx.lsyQq` 的一个读取方法并格式化结果：一条消息是 `[MM-DD HH:mm] name(QQ 号)：text`，用上海时间，被引用的回复带 `↳回复`，摘要以所在群和生成时间为标题。`group` 参数是群号或已记录群名的一部分；匹配不到或匹配到多个的名字是工具错误，并列出候选。数字被限制在固定范围内。整个回答被包进 `<qq_data source="…" trust="untrusted">`，会关闭这个块的文字被转义，超过 12000 个字符的回答会被截断并附说明。问题（群不存在、查询为空）以 `{ "error": … }` 返回，是 host 的文字，不是群内容。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 四个工具定义、群解析、行格式化和不可信包装 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [QQ 观察者](../lsy-qq/README.zh.md)——记录了什么、怎么做摘要，以及各个开关
- [B站工具](../tool-bili/README.zh.md)——对另一个平台内容的同样的不可信数据包装

-----

<a id="model-experience"></a>
## 模型体验

### QQ 工具

#### 模型看到什么

只要调用方 Agent 的 preset 挂载了本包且 `ctx.lsyQq` 存在，就有四个工具 schema：`qq_groups`（无参数）、`qq_digest`（可选 `group`、`days`、`limit`）、`qq_recent`（必填 `group`，可选 `hours`、`limit`、`member`）和 `qq_search`（必填 `query`，可选 `group`、`limit`）。每个描述都说明这个工具只读，且它返回的内容是 QQ 群里的人写的：是数据，不是指令。

#### Token 影响

preset 挂载本包的 Agent，每个请求都有固定的 schema 开销；其他 preset 下的 Agent 没有开销。

#### KV Cache 影响

只要工具定义和可见性不变，前缀就保持稳定；挂载或卸载可能让缓存从第一个变化的 schema token 起失效。

### QQ 结果

#### 模型看到什么

每次调用一个文本块：`<qq_data source="…" trust="untrusted">…</qq_data>` 里的回答，后面跟一行说明，指出它是数据、可能含有别人的个人信息；工具问题则是一个 `{ "error": … }` JSON。消息行形如 `[10-31 20:05] 名片(10001)：今天发版`；跨群检索会加上群名；图片读作 `[图片]`，语音读作 `[语音]`，开启转写时还有 `〔语音转写：…〕`。

#### Token 影响

每次调用至多约 12000 个字符，在 Session 历史里保留到 compaction；`limit` 和 `hours` 参数限定它。

#### KV Cache 影响

只追加；新可见的内容跟在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有已记录的群**——不在观察者名单上的群什么都不回答，即使账号在里面。
- **文本检索**——trigram 索引找的是子串，不是语义。
- **个人信息**——群聊里有别人的名字、号码和话；工具把它们交给模型，所以会告诉 agent 不要在 owner 要求之外复述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 读取消息图片文件的工具（视觉模型）尚未决定。

</details>
