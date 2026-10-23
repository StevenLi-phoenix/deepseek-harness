#!/usr/bin/env node
// Load a claude.ai memory export into <DSH_HOME>/lsy-memory/memory.jsonl (mode 600). Entries already
// present are skipped, so a re-run is harmless; it prints counts, never entry text. Run it as the
// service user from an installed build, so the file belongs to that user:
//   sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/memory-import.mjs < export.md
// --dry-run only counts. New Sessions see the entries at once; no restart is needed.
import { runImportCli } from '@deepseek-ai/dsh-lsy-memory'

process.exitCode = await runImportCli()
