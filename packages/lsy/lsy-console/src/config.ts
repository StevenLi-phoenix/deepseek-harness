/** Plugin configuration. */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface Config {
  /** bili-svc, probed at `<url>/healthz`. */
  bili: { url: string }
  /** The AMS intake receiver, probed at its root; an empty url leaves its card out. */
  ams: { url: string }
  /** Deadline of every probe, in milliseconds. */
  probeTimeoutMs: number
  /** The Claude Code sessions of this account; the defaults are those of `lsy-cc-bridge`, which this page works beside. */
  claudeCode: {
    enabled: boolean
    sessionsDir: string
    tmux: string
    command: string
    workDir: string
    model: string
    maxSessions: number
  }
  /** What the create form fills in for a subscription; those of `watch_create`. */
  subscriptions: {
    workspacePath: string
    agentPreset: string
    permissionPreset: string
    coalesceSeconds: number
    notifyMaxPerHour: number
    sessionMaxPerHour: number
  }
  /** The sentence the voice preview speaks. */
  previewText: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  bili: z.object({ url: z.string().default('http://127.0.0.1:8097') }),
  ams: z.object({ url: z.string().default('http://127.0.0.1:18090') }),
  probeTimeoutMs: z.natural().min(200).max(10_000).default(2000),
  claudeCode: z.object({
    enabled: z.boolean().default(true),
    sessionsDir: z.string().default(''),
    tmux: z.string().default('/opt/homebrew/bin/tmux'),
    command: z.string().default('/Users/dsh-runtime/bin/claude-dsh'),
    workDir: z.string().default('/Users/dsh-runtime/work/cc'),
    model: z.string().default('sonnet'),
    maxSessions: z.natural().min(1).max(10).default(3),
  }),
  subscriptions: z.object({
    workspacePath: z.string().default('/Users/dsh-runtime/work'),
    agentPreset: z.string().default('unattended'),
    permissionPreset: z.string().default('danger-full-access'),
    coalesceSeconds: z.natural().max(86_400).default(60),
    notifyMaxPerHour: z.natural().min(1).max(60).default(12),
    sessionMaxPerHour: z.natural().min(1).max(60).default(4),
  }),
  previewText: z.string().default('你好，我是魔女的猫猫。这是一条语音试听。'),
})
