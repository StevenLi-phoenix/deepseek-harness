/**
 * The miner's model call: DSH's LLM service on the profile's default route (`ctx.agentDefaultModel`, the cheap model the
 * event profile selects) unless the configuration names a provider and model, without a Session, tools, or memory.
 */

import type { Context } from '@deepseek-ai/cordis'
import { callModelOnce } from '@deepseek-ai/dsh-service-kit'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'speaking-style': true
  }
}

/** One call: a system prompt, the data as the user message, and the model's answer. */
export type ModelCall = (
  request: { readonly system: string; readonly user: string },
  signal: AbortSignal,
) => Promise<{ readonly text: string; readonly raw: unknown }>

/** The route and limits of the calls. */
export interface ModelSettings {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxOutputTokens: number
}

/**
 * Build the model call. An explicit route runs at the lightest reasoning effort the model offers.
 * @param ctx - the context holding `llm` and, for the default route, `agentDefaultModel`; both are read per call.
 * @param settings - route override and output cap.
 * @returns a function that rejects when no route exists, the call fails, or the stream ends abnormally.
 */
export function createModelCall(ctx: Context, settings: ModelSettings): ModelCall {
  return async ({ system, user }, signal) => {
    const { text, raw } = await callModelOnce(
      ctx,
      { ...settings, noRoute: 'no model route: set miner.provider and miner.model, or mount agentDefaultModel' },
      { system, user, source: { kind: 'speaking-style' }, purpose: 'speaking-style', signal },
    )
    return { text, raw }
  }
}
