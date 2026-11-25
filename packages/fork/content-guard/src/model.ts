/**
 * The default model call: DSH's own LLM service on the profile's default route (`ctx.agentDefaultModel`, the cheap model
 * the event profile selects) unless the configuration names another, without a Session, tools, or memory.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { callModelOnce } from '@deepseek-ai/dsh-service-kit'
import type { GuardModel, GuardModelAnswer } from './classifier.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Requests of the guard classifier.
     * @persistenceAttribution
     */
    'content-guard': { kind: 'content-guard' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'content-guard': true
  }
}

/** The route and limits one call uses. */
export interface ModelSettings {
  /** Explicit route; the profile's default route when both are undefined. */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxOutputTokens: number
}

/**
 * Build the model call over the LLM service. A classification needs no deep reasoning, so an explicit route runs at the
 * lightest effort the model offers.
 * @param ctx - the context holding `llm` and, for the default route, `agentDefaultModel`; both are read per call.
 * @param settings - route override and output cap.
 * @returns a function that rejects when no route exists, the call fails, or the stream ends abnormally.
 */
export function createLlmModel(ctx: Context, settings: ModelSettings): GuardModel {
  return async ({ system, user, signal }): Promise<GuardModelAnswer> => await callModelOnce(
    ctx,
    { ...settings, noRoute: 'no model route: set provider and model, or mount agentDefaultModel' },
    { system, user, source: { kind: 'content-guard' }, purpose: 'content-guard', signal },
  )
}
