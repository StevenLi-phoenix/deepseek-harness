/**
 * The default model call: DSH's own LLM service on the profile's default route (`ctx.agentDefaultModel`, the cheap model
 * the event profile selects) unless the configuration names another, without a Session, tools, or memory.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions } from '@deepseek-ai/dsh-llm'
// Type-only: ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { GuardModel, GuardModelAnswer } from './classifier.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'fork-guard': { kind: 'fork-guard' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'fork-guard': true
  }
}

/** Reasoning efforts that suit a classification, lightest first. */
const LIGHT_EFFORTS = ['off', 'none', 'minimal', 'low']

/** The route and limits one call uses. */
export interface ModelSettings {
  /** Explicit route; the profile's default route when both are undefined. */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxOutputTokens: number
}

/**
 * Build the model call over the LLM service.
 * @param ctx - the context holding `llm` and, for the default route, `agentDefaultModel`; both are read per call.
 * @param settings - route override and output cap.
 * @returns a function that rejects when no route exists, the call fails, or the stream ends abnormally.
 */
export function createLlmModel(ctx: Context, settings: ModelSettings): GuardModel {
  return async ({ system, user, signal }): Promise<GuardModelAnswer> => {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('the LLM service is not mounted')
    let route: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
    if (settings.provider !== undefined && settings.model !== undefined) {
      // A classification needs no deep reasoning: take the lightest effort the model offers.
      const info = await llm.resolveModelInfo(settings.provider, settings.model, signal)
      const offered = info.reasoning?.efforts ?? []
      const lightest = LIGHT_EFFORTS.map(wanted => offered.find(effort => effort.id === wanted)).find(effort => effort !== undefined)
      route = { provider: settings.provider, model: settings.model, ...lightest === undefined ? {} : { reasoningEffort: lightest.id } }
    } else {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (selection === undefined) throw new Error('no model route: set provider and model, or mount agentDefaultModel')
      const { provider, model, reasoningEffort } = selection
      route = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    }
    const options: GenerateOptions = {
      ...route,
      system,
      messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'fork-guard' } })],
      temperature: 0,
      maxTokens: settings.maxOutputTokens,
      purpose: 'fork-guard',
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
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    return { text, raw, model: `${route.provider}/${route.model}` }
  }
}
