---
description: "输入框下方统计栏里的余额小块：在活动与用量读数旁常驻显示 DeepSeek 账号余额，与账号设置页走同一个 Host 账号 Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

[English](README.md) | 中文

## 概述

不用打开设置，就能看到 DeepSeek 额度还剩多少。这个小块位于输入框下方，排在活动和用量读数之后，按币种显示总额（充值加赠金）。鼠标悬停时显示两部分各多少、何时读取。余额用完时变红；刷新失败时，上一次的读数变淡。点击它、窗口重新获得焦点、以及页面可见时每两分钟，都会刷新。没有登录 DeepSeek 账号时不显示。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。Host 需要提供 `account` Remote（`@deepseek-ai/dsh-api-account-controller` 加一个 DeepSeek 账号 provider），Web bundles 已经组合好了。

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

这个插件没有配置项。金额显示规则与账号设置页一致：保留两位小数并向下取整，不足一分显示 `<¥0.01`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器部分通过 `ctx.slots.inject` 注册一个 `conversation.composer.dock` 条目（`id: balance`，`order: 2`，排在 ui-chat 的 `activity` 和 `usage` 之后），因此跟随该插槽声明的生命周期。所有打开的输入框共用一个 store 和一个 `BalanceLoader`。loader 调用 `account.getBalance`，带上与账号设置页相同的客户端标识；进行中的请求会被共享；如果上一次结果还在调用方接受的时效内就跳过查询：挂载和定时器接受两分钟，窗口回到前台接受三十秒，点击则总是查询。返回 `null` 表示未登录，会清空钱包；返回失败时保留上一次成功的钱包，并只在控制台记一条不含任何 Host 文本的通用警告。金额是十进制字符串，用 `big.js` 求和，不经过浮点数。

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、基于账号 Remote 的 loader、插槽注册 |
| [`src/client/balance.ts`](src/client/balance.ts) | 钱包汇总、金额格式化、store 工厂、loader |
| [`src/client/BalancePill.tsx`](src/client/BalancePill.tsx) | 余额小块、悬停提示与刷新时机 |
| [`src/index.ts`](src/index.ts) | 空的 Host 部分，让这一行出现在 Host 插件列表里 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [账号设置](../../client/ui-settings-account/README.zh.md)——与这个小块共用余额查询的设置页
- [开放平台账号 provider](../../credentials/deepseek-account-platform/README.zh.md)——Host 读取钱包的地方

-----

<a id="model-experience"></a>
## 模型体验

无，这个小块属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只显示账号余额**——读取的是已登录的 DeepSeek 账号；API key 方式的 provider（包括官方 DeepSeek key 和 OpenRouter）不显示。
- **轮询而非推送**——消费会在下一次刷新时体现：页面可见时最多两分钟，点击则立即刷新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 每轮结束时刷新能比定时器更早反映消费；这需要一个插槽条目不必深入 ui-chat 就能观察到的 Session 事件。

</details>
