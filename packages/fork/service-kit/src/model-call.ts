/**
 * One model call without a Session, tools, or memory: DSH's LLM service on the profile's default route
 * (`ctx.agentDefaultModel`) unless the caller names a provider and model.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.agentDefaultModel.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRequestPurpose, MessageSource } from '@deepseek-ai/dsh-llm'

/** Reasoning efforts that suit a short classification or extraction, lightest first. */
const LIGHT_EFFORTS = ['off', 'none', 'minimal', 'low']

/** The route and limits of one call. */
export interface OneShotSettings {
  /** Explicit route; the profile's default route when either is undefined. */
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly maxOutputTokens: number
  /** The error text when there is no route: neither both of provider and model nor `agentDefaultModel`. */
  readonly noRoute: string
}

/** One request: the system prompt, the data as the only user message, and what the request is for. */
export interface OneShotRequest {
  readonly system: string
  readonly user: string
  /** The user message's source, as the caller declares it in `MessageSourceMap`. */
  readonly source: MessageSource
  readonly purpose: LlmRequestPurpose
  readonly signal: AbortSignal
}

/** The text of the answer, the stream's end with its usage and blocks, and the route that answered. */
export interface OneShotAnswer {
  readonly text: string
  readonly raw: { readonly finish: BlockAssembler['finish']; readonly usage: BlockAssembler['usage'] | null; readonly blocks: ReturnType<BlockAssembler['blocks']> }
  /** `provider/model`. */
  readonly model: string
}

/**
 * Call the model once at temperature 0. An explicit route runs at the lightest reasoning effort the model offers; the
 * default route keeps its own effort.
 * @param ctx - the context holding `llm` and, for the default route, `agentDefaultModel`; both are read per call.
 * @param settings - route override, output cap, and the error text without a route.
 * @param request - the prompt, the data, and what it is for.
 * @returns the answer's text and raw stream end.
 * @throws when the LLM service or a route is missing, the call fails, `signal` aborts, or the stream ends other than
 *   at a stop or the token cap; that error carries `raw`.
 */
export async function callModelOnce(ctx: Context, settings: OneShotSettings, request: OneShotRequest): Promise<OneShotAnswer> {
  const { signal } = request
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('the LLM service is not mounted')
  let route: Pick<GenerateOptions, 'provider' | 'model' | 'reasoningEffort'>
  if (settings.provider !== undefined && settings.model !== undefined) {
    const info = await llm.resolveModelInfo(settings.provider, settings.model, signal)
    const offered = info.reasoning?.efforts ?? []
    const lightest = LIGHT_EFFORTS.map(wanted => offered.find(effort => effort.id === wanted)).find(effort => effort !== undefined)
    route = { provider: settings.provider, model: settings.model, ...lightest === undefined ? {} : { reasoningEffort: lightest.id } }
  } else {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (selection === undefined) throw new Error(settings.noRoute)
    const { provider, model, reasoningEffort } = selection
    route = { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  }
  const options: GenerateOptions = {
    ...route,
    system: request.system,
    messages: [createUserMessage({ content: [{ type: 'text', text: request.user }], source: request.source })],
    temperature: 0,
    maxTokens: settings.maxOutputTokens,
    purpose: request.purpose,
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
  return { text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''), raw, model: `${route.provider}/${route.model}` }
}
