/**
 * The content guard. One validator, `ctx.forkGuard.check(text, { purpose, audience })`, for every writer of text that
 * other people can read (a persona update, a style note, a QQ group note, a Bilibili channel note). Patterns, canaries,
 * overlap with the owner's memory, and a model each get a say, and any layer that cannot run refuses.
 *
 * @module @deepseek-ai/dsh-fork-guard
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defaultMemoryFile, MemoryStore } from '@deepseek-ai/dsh-fork-memory'
import z from '@deepseek-ai/schemastery'
import { CanarySet } from './canary.ts'
import { RawStore } from './classifier.ts'
import { createLlmModel } from './model.ts'
import { GuardService, type GuardSettings } from './service.ts'

export { GUARD_CATEGORIES, GUARD_LABELS, GUARD_PROMPT_VERSION, GUARD_SYSTEM_PROMPT, guardUserMessage, parseGuardAnswer, RawStore, type GuardModel, type GuardModelAnswer, type ParsedAnswer, type RawRecord } from './classifier.ts'
export { CanarySet, parseCanaries } from './canary.ts'
export { fold, squash } from './fold.ts'
export { createLlmModel } from './model.ts'
export { LINK, LONG_NUMBER, luhn, MENTION, PATTERN_RULES, scanPatterns, type PatternOptions, type PatternRule } from './patterns.ts'
export { GuardService, type GuardDeps, type GuardLogger, type GuardSettings } from './service.ts'
export type { GuardAudience, GuardCheckOptions, GuardHealth, GuardVerdict } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The content guard: asks whether a text would leak private information into a place others can read. */
    forkGuard: GuardService
  }
}

/** Plugin name. */
export const name = 'fork-guard'

/** Plugin configuration. */
export interface Config {
  /** Which layers run. The model layer ignores `false` for audience `public`. */
  layers: {
    /** Phone, email, ID, card, long-number, mention, address, and link patterns. */
    patterns: boolean
    /** The canary file and `extraCanaries`. */
    canary: boolean
    /** Overlap with the owner's memory entries. */
    memory: boolean
    /** The model's judgement; always runs for audience `public`. */
    llm: boolean
  }
  /** Refuse any link, not only one that carries a token or an account id. */
  blockLinks: boolean
  /** Absolute path of the canary file, one string per line (`#` comments); defaults to `<DSH_HOME>/fork-guard/canaries.txt`. */
  canaryFile?: string
  /** Canary strings from the configuration, on top of the file: honeypot tokens. */
  extraCanaries: string[]
  /** Absolute path of fork-memory's memory file; defaults to `<DSH_HOME>/fork-memory/memory.jsonl`. */
  memoryFile?: string
  /** Provider of the model layer's route; set together with `model`. Unset uses the profile's default model. */
  provider?: string
  /** Model id of the model layer's route; set together with `provider`. */
  model?: string
  /** Deadline of one model call, in milliseconds. */
  timeoutMs: number
  /** Output cap of one model call, in tokens. */
  maxOutputTokens: number
  /** Longest text checked, in characters; a longer one is refused. */
  maxChars: number
  /** Hours a model verdict is reused for the same text, purpose, and audience. */
  cacheHours: number
  /** Directory of `canaries.txt` and `raw/`; defaults to `<DSH_HOME>/fork-guard`. */
  dir?: string
  /** Days the model's raw responses are kept. */
  rawRetentionDays: number
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  layers: z.object({
    patterns: z.boolean().default(true).description('Run the patterns for phone, email, ID, card, long numbers, mentions, addresses, and links.'),
    canary: z.boolean().default(true).description('Refuse text that contains a canary string.'),
    memory: z.boolean().default(true).description('Refuse text that repeats a distinctive span of the owner\'s memory.'),
    llm: z.boolean().default(true).description('Ask a model whether the text reveals private information. Text for the public audience is always asked.'),
  }).description('Which layers run, in this order.'),
  blockLinks: z.boolean().default(true).description('Refuse any link, not only one that carries a token or an account id.'),
  canaryFile: z.string().description('Canary file, one string per line. Default: <DSH_HOME>/fork-guard/canaries.txt.'),
  extraCanaries: z.array(z.string()).default([]).description('Canary strings kept in the configuration, on top of the file (honeypot tokens).'),
  memoryFile: z.string().description('The owner memory file to compare against. Default: <DSH_HOME>/fork-memory/memory.jsonl.'),
  provider: z.string().description('Provider of the model layer. Set together with model; unset uses the profile\'s default model.'),
  model: z.string().description('Model id of the model layer. Set together with provider.'),
  timeoutMs: z.natural().min(1000).default(20_000).description('Deadline of one model call, in milliseconds.'),
  maxOutputTokens: z.natural().min(64).default(400).description('Output cap of one model call, in tokens.'),
  maxChars: z.natural().min(100).default(20_000).description('Longest text checked, in characters. A longer text is refused.'),
  cacheHours: z.natural().min(1).default(24).description('Hours a model verdict is reused for the same text, purpose, and audience.'),
  dir: z.string().description('Directory for canaries.txt and raw responses. Default: <DSH_HOME>/fork-guard.'),
  rawRetentionDays: z.natural().min(1).default(14).description('Days the model\'s raw responses are kept on disk.'),
})

/** Fail at load on configuration that cannot work. */
function assertConfig(config: Config): void {
  for (const key of ['canaryFile', 'memoryFile', 'dir'] as const) {
    const value = config[key]
    if (value !== undefined && !isAbsolute(value)) throw new Error(`fork-guard: ${key} must be an absolute path`)
  }
  if ((config.provider === undefined) !== (config.model === undefined)) throw new Error('fork-guard: provider and model must be set together')
}

/**
 * Mount the guard at the root.
 * @param ctx - the root context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const dir = config.dir ?? join(resolveDshHome(), 'fork-guard')
  const settings: GuardSettings = {
    layers: config.layers,
    blockLinks: config.blockLinks,
    timeoutMs: config.timeoutMs,
    maxChars: config.maxChars,
    cacheMs: config.cacheHours * 3_600_000,
  }
  const raw = new RawStore(dir, config.rawRetentionDays)
  const service = new GuardService({
    settings,
    canaries: new CanarySet(config.canaryFile ?? join(dir, 'canaries.txt'), config.extraCanaries),
    memory: new MemoryStore(config.memoryFile ?? defaultMemoryFile()),
    model: createLlmModel(ctx, { provider: config.provider, model: config.model, maxOutputTokens: config.maxOutputTokens }),
    raw,
    logger: ctx.logger,
  })
  ctx.logger.info(
    'fork-guard: layers patterns=%s canary=%s memory=%s llm=%s (always for public), model %s, raw responses in %s kept %d days',
    config.layers.patterns, config.layers.canary, config.layers.memory, config.layers.llm,
    config.provider === undefined ? 'the profile default' : `${config.provider}/${config.model ?? ''}`, join(dir, 'raw'), config.rawRetentionDays,
  )
  void raw.prune().catch((error: unknown) => { ctx.logger.warn('fork-guard: pruning raw responses failed: %s', error instanceof Error ? error.message : String(error)) })
  // ctx.provide is itself an effect: the service goes when this plugin unloads.
  ctx.provide('forkGuard', service)
}
