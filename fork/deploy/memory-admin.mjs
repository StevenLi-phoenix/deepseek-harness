#!/usr/bin/env node
// Review and undo memory changes in <DSH_HOME>/fork-memory: waiting writes, per-Session rollback, and erasing an entry
// with every trace. It prints ids, categories, and counts, never entry text. Run it as the service user from an installed build:
//   sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/fork-dsh/current/fork/deploy/memory-admin.mjs ids
// Commands: ids, approve <id>..., discard <id>..., revert <id>..., rollback --session <id>|--since <ISO> [--dry-run], forget --purge <id>...
import { runAdminCli } from '@deepseek-ai/dsh-fork-memory'

process.exitCode = await runAdminCli()
