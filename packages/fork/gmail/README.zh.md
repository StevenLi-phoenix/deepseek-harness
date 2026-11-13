---
description: "主人在 DSH 里的 Gmail 账号，即 ctx.gmail：每个账号（工作、个人、bot）各自一次 Google 登录，refresh token 存在凭据库里，Gmail REST 客户端，邮件拼装，以及发信关卡：账号规则和这一轮的来源要求时，把邮件留成 Gmail 草稿，并在微信上带确认码问主人。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gmail

[English](README.md) | 中文

## 概述

让 agent 读你连上的每个 Gmail 账号的信、写草稿、发信，同时不让陌生人的一封邮件指使它发出任何东西。每个账号有一条发信规则：只读、全部确认、确认有风险的、或直接发。这一轮不是你单独发起的、agent 在这一轮读过邮件或网页、或者收件人是新地址，这封信就算有风险。它留成 Gmail 草稿，由 DSH 按固定规则在微信上连同确认码拿给你看；只有你回复 `发送 确认码` 或在 设置 → 邮箱 里确认，它才会发出。

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

把它挂在进程根上，该进程还要挂载 storage domain、凭据库和一个通知服务，比如 [`@deepseek-ai/dsh-fork-wechat`](../fork-wechat/README.zh.md)。fork event bundle 用默认配置挂载它，旁边是 [`gmail-settings`](../gmail-settings/README.zh.md)，后者提供 Google 登录完成后跳回的页面；工具在 [`tool-gmail`](../tool-gmail/README.zh.md)。

```yaml
- id: gmail
  name: '@deepseek-ai/dsh-gmail'
```

连接账号前，先建一个 Google Cloud 项目：启用 Gmail API，配置 OAuth 同意屏幕，建一个类型为 Web application 的 OAuth client，重定向 URI 填 `<DSH 地址>/gmail.oauth`（设置页会显示准确的值）。把 client 的 JSON 文件粘贴到 设置 → 邮箱；id 和 secret 会以 `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET` 存进凭据库。然后逐个添加账号，id 自己起（`work`、`personal`、`bot`），用对应地址登录。唯一申请的权限是 `gmail.modify`：读信、写草稿、发信、改标签，不能永久删除。停在 Testing 状态的应用，登录七天后失效，所以要把同意屏幕发布为 In production。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `clientIdEnv` / `clientSecretEnv` | `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | OAuth client id 和 secret 在凭据库或 `$DSH_HOME/.env` 里的名字 |
| `redirectUri` | `''` | 在 Google 注册的重定向 URI；留空则取 `<设置页地址>/gmail.oauth`，必须是 https 或 localhost |
| `trustedRecipients` | `[]` | 除了已连接账号自己的地址外，每个账号都可以直接发信的地址；加载时检查 |
| `maxSendsPerDay` | `50` | 一个账号 24 小时内最多发的信；超过的被拒绝 |
| `confirmTtlHours` | `72` | 待确认的信等主人多少小时后作废 |
| `requestTimeoutMs` | `30000` | 一次 Google 调用的超时 |
| `maxSearchResults` | `20` | 一次搜索最多返回的会话数（最多 50） |
| `maxBodyChars` / `maxHtmlChars` | `20000` / `500000` | 给模型看的一封正文字符数，以及最多读取的 HTML 正文字符数 |
| `maxThreadMessages` | `10` | 一个会话显示的最新邮件数；更早的只计数 |
| `maxAttachmentBytes` / `maxDownloadBytes` | 18 MiB / 25 MiB | 一封外发邮件的全部附件，以及保存的一个收到的附件 |

### 发信规则

| 规则 | 发信 |
|---|---|
| `read-only` | 什么都不发：只能搜索和读信；草稿、发信、改标签都被拒绝 |
| `confirm-all` | 每封信都等主人确认 |
| `confirm-untrusted`（新账号的默认值） | 每个收件人都是主人自己的地址或 `trustedRecipients` 时直接发；否则只在干净的一轮里（主人单独发起，且没有工具读过外人的文字）、每个收件人都出现在主人这一轮自己的话里或这个账号给对方发过信（已发送邮件）时直接发；其余都等确认 |
| `direct` | 直接发；给 bot 账号用 |

### 规则

- **这一轮的事实**：这一轮是否干净、来源和主人自己的话都经 [`fork-taint`](../fork-taint/README.zh.md) 从 Session 日志里读出；模型一样也提供不了。读信（`gmail_search`、`gmail_read`、`gmail_attachment`）会让这一轮变得不干净。
- **待确认**：待确认的信留成 Gmail 草稿，并得到一个六位确认码；发给主人的微信通知列出发件人、收件人、抄送、密送、主题、附件、为什么要确认，以及正文前 400 个字符。关卡判断的、通知展示的都是 Gmail 存下的草稿（它的 RFC 5322 原文），并记下它的 SHA-256。
- **确认**：在设置页确认；或者在干净的一轮里，主人的消息中单独出现了这个确认码，agent 在读任何邮件或网页之前用这个码调用 `gmail_send`。发出前会重新读一遍草稿：被改过的草稿作废、不发；被删掉的直接丢弃；账号已改成只读则什么都不发。
- **作废**：没确认的信过了 `confirmTtlHours` 作废；草稿留在 Gmail 里。待确认的草稿 agent 既改不了也发不了。
- **上限**：每一封发出的信（包括确认后发出的）都计入账号滚动 24 小时的上限；超出的发信被拒绝。
- **附件**：要附的文件必须（跟随链接后）是 Session 工作目录或系统临时目录里的普通文件，不在 `.gmail-inbox/` 以外的隐藏目录里，文件名也不能像密钥或凭据。收到的附件存到 `<cwd>/.gmail-inbox/`（目录 0700、文件 0600，git 忽略）。
- **重新登录**：Google 拒绝 refresh token 时，账号被标记，对它的每次调用都失败，主人收到一条微信通知，去设置页重新登录。
- **移除**：在 Google 撤销 token、删掉它，并丢弃这个账号所有待确认的信。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

登录是带 PKCE（S256）的授权码请求，申请离线访问并强制显示同意页，这样 Google 会返回 refresh token；`state` 只在内存里保存十分钟，只能用一次，同时最多 20 个。refresh token 是 `ctx.credentials` 里的 grant 记录（`gmail/<account>`）；access token 只在内存里，过期前一分钟刷新，每个账号同时只刷新一次，Google 轮换的 refresh token 会存下来。REST 客户端遇到 401 丢掉 token 重试一次，429 稍等后重试，5xx 或连接断开只对可以安全重复的调用重试，所以一封信不会发两次。新邮件拼成 RFC 5322 原文（base64 的 UTF-8 正文、RFC 2047 信头、RFC 2231 文件名，回复带 `In-Reply-To` 和 `References`），地址都检查成简单的 dot-atom 形式，带换行的信头值被拒绝，所以任何参数都加不了信头或隐藏收件人。收到的正文取 `text/plain` 部分，没有时把 HTML 一次线性扫描转成文字（不建 DOM），按每部分声明的字符集解码，并切掉引用的历史。草稿的密送从 `format=raw` 读，因为解析后的草稿可能不带它。确认、丢弃、完成登录、移除和改规则一次只执行一个。每个操作都记录账号、耗时和结果；token、Google 返回的授权码和 secret 从不写进日志。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务 `ctx.gmail`：配置、账号、token、读信、草稿、发信流程、待确认的信、登录、设置页状态 |
| [`src/gate.ts`](src/gate.ts) | 发信判断、主人点名的地址、凭确认码确认 |
| [`src/oauth.ts`](src/oauth.ts) | Google OAuth：PKCE、同意页地址、换取授权码、刷新、撤销 |
| [`src/api.ts`](src/api.ts) | Gmail REST 客户端：重试、上传、带类型的失败 |
| [`src/mime.ts`](src/mime.ts) | 外发邮件的拼装 |
| [`src/address.ts`](src/address.ts) | 收件人解析与检查 |
| [`src/message.ts`](src/message.ts) | 收到的邮件：信头、正文和附件 |
| [`src/html.ts`](src/html.ts) | HTML 正文转纯文字 |
| [`src/attachments.ts`](src/attachments.ts) | 要附的文件和要保存的收到的附件 |
| [`src/storage.ts`](src/storage.ts) | Storage domain `gmail`：账号、待确认和已处理的信、发信记录、动态 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Gmail 工具](../tool-gmail/README.zh.md)：主 agent 调用什么
- [设置 → 邮箱](../gmail-settings/README.zh.md)：client、账号、待确认的信和登录页
- [这一轮的来源](../fork-taint/README.zh.md)：一轮怎样分类

-----

<a id="model-experience"></a>
## 模型体验

### 聊天 Session 里的通知

#### 模型看到什么

没有为模型注册任何东西。微信通道会把每条通知的副本作为来自另一个 Session 的通知留在主人的聊天 Session 里，它的 `origin` 说明通知来自 Gmail 发信关卡（固定规则，不是模型），并说明待确认的信只有在主人自己的下一条消息里带上确认码、agent 随后用这个码调用 `gmail_send`，或主人在设置页确认时才会发出。待确认的信的通知标题是 `✉️ 待你确认：<account> 发给 <第一个收件人>[ 等]`，列出发件人、收件人、主题、附件、原因、正文开头和 `要发就回复「发送 <code>」`。重新登录通知的标题是 `⚠️ Gmail <account>（<地址>）要重新登录`。

#### Token 影响

每封待确认的信一次通知文字，通常 200 到 700 字符；每次登录被拒一次；只在主人的聊天 Session 里。

#### KV Cache 影响

只追加；通知跟在可复用的请求前缀之后，不会使已有的 KV Cache 失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **关卡管的是工具，不是机器**：refresh token 存在 DSH 用户的凭据库里，以这个用户身份运行的 shell 或代码工具能读到它们并直接调 Google；真正的隔离要把 token 放到另一个用户下。
- **没有新邮件触发**：agent 在被要求或定时任务运行时才读信；Gmail 推送（Pub/Sub watch）没有接入。
- **更早的轮次**：干净的一轮里，模型上下文中仍可能留着前几轮读到的文字；收件人必须被主人点名或以前发过信，这条规则限制了这些文字能做的事。
- **Workspace 账号**：组织的 Google Workspace 管理员可以屏蔽未经 Google 验证的应用。
- **接收不等于送达**：微信回复窗口关着时，待确认通知会排队；无论如何，设置页都列出每一封待确认的信。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- 没有用 Gmail MCP 连接器（claude.ai 的或社区的服务器）：DSH 需要在一个进程里管多个账号、需要模型绕不过去的发信关卡，也不想让第三方持有 token。

</details>
