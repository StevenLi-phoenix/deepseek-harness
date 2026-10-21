#!/usr/bin/env node
// Bind a WeChat bot to the event service: shows a QR code, asks for the number WeChat may show,
// and writes <DSH_HOME>/lsy-wechat/account.json (mode 600). Prints the bot and owner ids, never the token.
// Run it as the service user from an installed build, so the account file belongs to that user:
//   sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/wechat-login.mjs
// The running service picks the new account up within 30 seconds; no restart is needed.
import { runLoginCli } from '@deepseek-ai/dsh-lsy-wechat'

process.exitCode = await runLoginCli()
