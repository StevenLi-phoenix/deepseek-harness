---
description: "fork 各设置页共用的浏览器端帮助代码：页面可见时轮询、进行中的读取由调用方共享、时间与时长文字、状态行，以及卡片、状态头和等待首个回答时的标记。"
kind: "package-library"
---

# @deepseek-ai/dsh-settings-kit

[English](README.md) | 中文

## 概述

fork 的各个设置页用同样的方式刷新、表述状态、排布卡片，所以共用这一份代码。它在页面可见时轮询，在读取进行中时让所有调用方共享同一次读取，输出时间和时长，并渲染状态头、带标题的卡片，以及设置页在拿到第一个回答之前显示的那一行。每个部件都使用设置页自己的样式表和文案，所以每一页保留自己的外观和八种语言。

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

在设置页的浏览器代码里导入 `@deepseek-ai/dsh-settings-kit/client`，并把这个包列进该设置页包的 `devDependencies`。这个子路径是 Client 编译器的输出，Client 构建把它内联进每个设置页的 bundle（它在 `packages/client/tsdown.client.ts` 的 `INLINE_SAFE` 里），因为它的导出没有状态，也没有需要共享的身份；包的根入口只有类型。它不是插件，从不挂载。

```ts
import { Card, shareInFlight, startPolling, StatusHeader, statusLine, stampTime } from '@deepseek-ai/dsh-settings-kit/client'

useEffect(() => startPolling(refresh, 5000), [refresh])
const status = statusLine(view === null ? null : state.checkedAt, state.stale, translate, { time: stampTime, waiting: 'idle' })
return <section className={css.section}><StatusHeader css={css} line={status} />…</section>
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`startPolling(refresh, interval, page)` 立即刷新一次，之后每个周期刷新一次；周期是一个数，或一个在每次刷新后询问的函数。页面隐藏时停掉定时器，重新显示时立即刷新。`shareInFlight(run)` 在一次运行结束（无论成功还是失败）之前，把它交给每个调用方。`statusLine(shownAt, stale, t, wording)` 从设置页的词典读取 `status.loading`、`status.failed`、`status.stale` 和 `status.live`。各组件从设置页的 CSS module 里读取各自注明的类名，自身不带文案。

| 文件 | 作用 |
|---|---|
| [`src/client.ts`](src/client.ts) | `./client` 的导出 |
| [`src/index.ts`](src/index.ts) | 根入口的类型 |
| [`src/polling.ts`](src/polling.ts) | `startPolling` 及它监听的页面可见性 |
| [`src/in-flight.ts`](src/in-flight.ts) | `shareInFlight` |
| [`src/time-text.ts`](src/time-text.ts) | `stampTime`、`dateTime`、`formatDuration`、`minutesAgo` |
| [`src/status.ts`](src/status.ts) | `statusLine` 及其色调 |
| [`src/parts.tsx`](src/parts.tsx) | `StatusHeader`、`Card`、`PendingSection` |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [fork 的包](../README.zh.md) —— 导入它的各个设置页

-----

<a id="model-experience"></a>
## 模型体验

无，这个包是内联进设置页的浏览器界面代码；这里没有任何东西进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **文案留在各设置页** —— 每个部件都从调用方的词典读取文字，所以缺少部件所需某个键的设置页会编译失败，而不是显示一个后备文字。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

无。

</details>
