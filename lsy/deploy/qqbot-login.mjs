#!/usr/bin/env node
// Create or bind the QQ bot of the event service: shows a QR code for the phone's QQ, and after the scan writes
// LSY_QQBOT_APP_ID and LSY_QQBOT_APP_SECRET into <DSH_HOME>/.env (mode 600). Prints the AppID and the scanner's openid
// (the first entry for lsy-qqbot's allow.users), never the AppSecret. Options: --qr-png <file> also saves the code as
// an image, --timeout-min <n> sets the wait (default 10), --env-file <file> overrides the target.
// Run it as the service user from an installed build, so the file belongs to that user:
//   sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/qqbot-login.mjs
// Restart the service afterwards: .env is read at launch.
import { runLoginCli } from '@deepseek-ai/dsh-lsy-qqbot'

process.exitCode = await runLoginCli()
