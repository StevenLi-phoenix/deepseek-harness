/**
 * The miner's model call: DSH's LLM service on the profile's default route (`ctx.agentDefaultModel`, the cheap model the
 * event profile selects) unless the configuration names a provider and model, without a Session, tools, or memory.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'speaking-style': true
  }
}

/** Reasoning efforts that suit extraction, lightest first. */
const LIGHT_EFFORTS = ['off', 'none', 'minimal', 'low']

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
 * Build the model call.
 * @param ctx - the context holding `llm` and, for the default route, `agentDefaultModel`; both are read per call.
 * @param settings - route override and output cap.
 * @returns a function that rejects when no route exists, the call fails, or the stream ends abnormally.
 */
export function createModelCall(ctx: Context, settings: ModelSettings): ModelCall {
  return async ({ system, user }, signal) => {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('the LLM service is not mounted')
    let route: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
    if (settings.provider !== undefined && settings.model !== undefined) {
      const info = await llm.resolveModelInfo(settings.provider, settings.model, signal)
      const lightest = LIGHT_EFFORTS.map(wanted => info.reasoning?.efforts.find(effort => effort.id === wanted))
        .find(effort => effort !== undefined)
      route = { provider: settings.provider, model: settings.model, ...lightest === undefined ? {} : { reasoningEffort: lightest.id } }
    } else {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (selection === undefined) throw new Error('no model route: set miner.provider and miner.model, or mount agentDefaultModel')
      const { reasoningEffort } = selection
      route = { provider: selection.provider, model: selection.model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    }
    const options: GenerateOptions = {
      ...route,
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'speaking-style' } })],
      temperature: 0,
      maxTokens: settings.maxOutputTokens,
      purpose: 'speaking-style',
      signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    const blocks = assembler.blocks()
    const raw = { finish, usage: assembler.usage ?? null, blocks }
    if (finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
      const detail = finish.kind === 'error' || finish.kind === 'aborted' ? `${finish.failure.code}: ${finish.failure.message}` : finish.kind
      throw Object.assign(new Error(`the model call ended with ${finish.kind} (${detail})`), { raw })
    }
    return { text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''), raw }
  }
}
