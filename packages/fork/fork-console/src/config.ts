/** Plugin configuration. */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. */
export interface Config {
  /** bili-svc, the Bilibili service. */
  bili: {
    /** Base URL; the card probes `<url>/healthz`. */
    url: string
  }
  /** The AMS intake receiver of other machines' warnings. */
  ams: {
    /** Base URL; any answer below 500 counts as reachable. Empty leaves its card out. */
    url: string
  }
  /** Deadline of every probe, in milliseconds. */
  probeTimeoutMs: number
  /** What the create form fills in for a subscription; the defaults are those of `watch_create`. */
  subscriptions: {
    /** Absolute Workspace of the Sessions a `session` subscription starts. */
    workspacePath: string
    /** Agent preset of those Sessions. */
    agentPreset: string
    /** Permission preset of those Sessions. */
    permissionPreset: string
    /** Seconds after the first event during which later events join the same batch. */
    coalesceSeconds: number
    /** Batches per rolling hour of a `notify` subscription. */
    notifyMaxPerHour: number
    /** Batches per rolling hour of a `session` subscription. */
    sessionMaxPerHour: number
  }
  /** The sentence the voice preview speaks; at most the voice service's `tts.maxChars` characters. */
  previewText: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  bili: z.object({ url: z.string().default('http://127.0.0.1:8097') }),
  ams: z.object({ url: z.string().default('http://127.0.0.1:18090') }),
  probeTimeoutMs: z.natural().min(200).max(10_000).default(2000),
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
