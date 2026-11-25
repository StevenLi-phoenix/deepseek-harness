---
kind: upgrade-guide
description: Gmail OAuth 的自定义重定向 URI 必须使用准确的回调路径。
---

# Gmail OAuth 重定向 URI

[English](guide.md) | 中文

## 变更

以前 `gmail.redirectUri` 接受任意路径，但 Web Host 只在 `/gmail.oauth` 提供回调。现在 Gmail 不接受其他路径，也不接受 URI 里的凭据、查询参数或片段。留空时仍从设置页来源生成 URI。

## 迁移

1. 如果你在 `gmail` 插件配置里设置了 `redirectUri`，请改成 `https://<你的 DSH 主机>/gmail.oauth`（`localhost` 和 `127.0.0.1` 可以用 HTTP）。在 Google Cloud 中把同一个 OAuth 客户端的「已获授权的重定向 URI」改成完全一致的地址。
2. 在 DSH「设置 → 邮箱」检查显示的 URI，再从这里开始一次新的连接。如果上一次是在升级前发起的，不要再打开旧链接。
