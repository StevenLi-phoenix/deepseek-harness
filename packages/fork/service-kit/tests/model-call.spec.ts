/** One model call without a Session: its route, its request, and how it ends. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { callModelOnce, type OneShotRequest } from '../src/index.ts'

/** A context holding a scripted LLM service that records the stream options. */
function setup(
  chunks: StreamChunk[],
  efforts: string[] | undefined,
  selection?: { provider: string; model: string; reasoningEffort?: string },
  llmMounted = true,
) {
  const streamed: GenerateOptions[] = []
  const llm = {
    resolveModelInfo: vi.fn(async () => (efforts === undefined ? {} : { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } })),
    stream: async function* (options: GenerateOptions) { streamed.push(options); yield* chunks },
  }
  const ctx = {
    get: (name: string) => (name === 'llm' ? (llmMounted ? llm : undefined) : name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined),
  } as never as Context
  return { ctx, streamed }
}

const request = (signal = new AbortController().signal): OneShotRequest => ({
  system: 'sys', user: 'data', source: { kind: 'speaking-style' }, purpose: 'speaking-style', signal,
})
const settings = { maxOutputTokens: 300, noRoute: 'no route here' }

describe('callModelOnce', () => {
  it('runs an explicit route at the lightest effort offered and names the model that answered', async () => {
    const { ctx, streamed } = setup(textResponse('好'), ['high', 'minimal'])
    const answer = await callModelOnce(ctx, { ...settings, provider: 'p', model: 'm' }, request())
    expect(answer).toMatchObject({ text: '好', model: 'p/m', raw: { finish: { kind: 'stop' } } })
    expect(streamed[0]).toMatchObject({ provider: 'p', model: 'm', reasoningEffort: 'minimal', system: 'sys', temperature: 0, maxTokens: 300, purpose: 'speaking-style' })
    expect(streamed[0]!.messages[0]).toMatchObject({ role: 'user', source: { kind: 'speaking-style' }, content: [{ type: 'text', text: 'data' }] })
  })

  it('follows the default route, and accepts an answer cut at the token cap', async () => {
    const { ctx, streamed } = setup(maxTokensResponse('半'), undefined, { provider: 'dp', model: 'dm' })
    expect((await callModelOnce(ctx, settings, request())).model).toBe('dp/dm')
    expect(streamed[0]).not.toHaveProperty('reasoningEffort')
  })

  it('asks no effort of a model without a light one, and keeps the default route\'s own effort', async () => {
    for (const efforts of [undefined, ['high']]) {
      const { ctx, streamed } = setup(textResponse('好'), efforts)
      await callModelOnce(ctx, { ...settings, provider: 'p', model: 'm' }, request())
      expect(streamed[0]).not.toHaveProperty('reasoningEffort')
    }
    const { ctx, streamed } = setup(textResponse('好'), undefined, { provider: 'dp', model: 'dm', reasoningEffort: 'low' })
    await callModelOnce(ctx, settings, request())
    expect(streamed[0]).toMatchObject({ reasoningEffort: 'low' })
  })

  it('names the failure of an error finish', async () => {
    const reason = { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } }
    const { ctx } = setup([{ type: 'finish', reason } as StreamChunk], undefined, { provider: 'dp', model: 'dm' })
    await expect(callModelOnce(ctx, settings, request())).rejects.toThrow('the model call ended with error (RATE_LIMIT: slow down)')
  })

  it('rejects without the LLM service, without a route, on a failed finish, and on abort', async () => {
    await expect(callModelOnce(setup([], undefined, undefined, false).ctx, settings, request())).rejects.toThrow('the LLM service is not mounted')
    await expect(callModelOnce(setup([], undefined).ctx, settings, request())).rejects.toThrow('no route here')
    const failed = await callModelOnce(setup([{ type: 'finish', reason: { kind: 'tool-calls' } }], undefined, { provider: 'dp', model: 'dm' }).ctx, settings, request())
      .catch((error: unknown) => error)
    expect((failed as Error).message).toBe('the model call ended with tool-calls (tool-calls)')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(callModelOnce(setup(textResponse('x'), undefined, { provider: 'dp', model: 'dm' }).ctx, settings, request(controller.signal))).rejects.toThrow('stopped')
  })
})
