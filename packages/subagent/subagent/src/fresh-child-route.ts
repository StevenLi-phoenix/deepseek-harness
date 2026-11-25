/**
 * The fresh-child route of the subagent runtime: which LLM route a child that does not inherit the parent's
 * conversation runs on when neither the call nor the tool names one.
 */

import type { SubagentProvider, SubagentStartRequest } from './types.ts'

/** The route a fresh child runs on when nothing else names one. */
export interface FreshChildRoute {
  /** LLM provider route id, as in `llm-pi-ai` providers. */
  provider: string
  /** Model id on that route. */
  model: string
  /** Reasoning effort when the call names none; unset, the model's own default. */
  reasoningEffort?: string
}

/**
 * Apply the configured fresh-child route to a start request that names no
 * route of its own. Only fresh children take it: a forked child continues the
 * parent's conversation, whose history belongs to the parent's route.
 * @param spec - the start request as the tool built it.
 * @param provider - the selected backend.
 * @param route - `freshChildRoute`, if configured.
 * @returns the request, with the route filled in when it applies.
 */
export function withFreshChildRoute<T extends { readonly agentOptions?: SubagentStartRequest['agentOptions'] }>(
  spec: T,
  provider: Pick<SubagentProvider, 'inheritsParentContext' | 'capabilities'>,
  route: FreshChildRoute | null | undefined,
): T {
  if (route === null || route === undefined || provider.inheritsParentContext || !provider.capabilities.agentOptions) return spec
  if (spec.agentOptions?.provider !== undefined || spec.agentOptions?.model !== undefined) return spec
  const effort = spec.agentOptions?.reasoningEffort ?? route.reasoningEffort
  return {
    ...spec,
    agentOptions: {
      ...spec.agentOptions,
      provider: route.provider,
      model: route.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    } as T['agentOptions'],
  }
}
