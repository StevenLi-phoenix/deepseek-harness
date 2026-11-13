#!/usr/bin/env node
// Review and undo memory changes in <DSH_HOME>/owner-memory: waiting writes, per-Session rollback, and erasing an entry
// with every trace. `ids` prints ids, categories, and counts without text; `recent` and `show` print text so the owner can
// find the entry a notice meant. Run it as the service user from an installed build (RUNBOOK 15 has the ssh form):
//   sudo -n -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/dsh/current/fork/deploy/memory-admin.mjs ids
// Commands: ids, recent [--limit n], show <id>, approve <id>..., discard <id>..., revert <id>..., rollback --session <id>|--since <ISO> [--dry-run], forget --purge <id>..., feedback add|list|forget (the owner's keep/delete verdicts on persona replies; `add` reads one JSON object on stdin)
import { runAdminCli } from '@deepseek-ai/dsh-owner-memory'

process.exitCode = await runAdminCli()
