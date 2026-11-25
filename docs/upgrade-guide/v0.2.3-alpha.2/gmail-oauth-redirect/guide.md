---
kind: upgrade-guide
description: A configured Gmail OAuth redirect URI must use the exact callback path.
---

# Gmail OAuth redirect URI

English | [中文](guide.zh.md)

## Change

`gmail.redirectUri` was accepted with arbitrary paths, even though the Web Host serves the callback at `/gmail.oauth`. Gmail now rejects configured URIs with a different path, embedded credentials, a query, or a fragment. A blank `redirectUri` still derives the URI from the Settings origin.

## Migration

1. If you set `redirectUri` in the `gmail` plugin configuration, use `https://<your DSH host>/gmail.oauth` (HTTP is accepted for `localhost` and `127.0.0.1`). Change the Authorized redirect URI in Google Cloud for the same OAuth client to match exactly.
2. Verify the URI shown in DSH Settings → 邮箱 and start a new connection there. If the last attempt began before the upgrade, do not reuse its link.
