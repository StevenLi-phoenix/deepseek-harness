import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createModelCall } from '../src/model.ts'

interface Services {
  llm?: object | undefined
  selection?: { provider: string; model: string; reasoningEffort?: string } | undefined
}

/** A context holding a scripted LLM service: it records the stream options and replays the chunks. */
function setup(chunks: StreamChunk[], efforts: string[] | undefined, services: Services = {}) {
  const streamed: GenerateOptions[] = []
  const llm = 'llm' in services ? services.llm : {
    resolveModelInfo: vi.fn(async () => ({
      ...efforts === undefined ? {} : { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } },
    })),
    stream: async function* (options: GenerateOptions) { streamed.push(options); yield* chunks },
  }
  const ctx = {
    get: (name: string) => (name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => services.selection } : undefined),
  } as never as Context
  return { ctx, streamed, llm }
}

const request = { system: 'sys', user: 'data' }

describe('createModelCall', () => {
  it('uses the configured route with the lightest reasoning effort the model offers, and joins the text blocks', async () => {
    const { ctx, streamed } = setup(textResponse('你好'), ['high', 'low', 'minimal'])
    const call = createModelCall(ctx, { provider: 'p', model: 'm', maxOutputTokens: 500 })
    const answer = await call(request, new AbortController().signal)
    expect(answer.text).toBe('你好')
    expect(streamed[0]).toMatchObject({ provider: 'p', model: 'm', reasoningEffort: 'minimal', system: 'sys', temperature: 0, maxTokens: 500, purpose: 'fork-style' })
    expect(answer.raw).toMatchObject({ finish: { kind: 'stop' }, usage: { inputTokens: 10 } })
  })

  it.each([
    ['a model with no reasoning info', undefined],
    ['a model whose efforts are all heavier than low', ['medium', 'high']],
  ])('asks for no reasoning effort from %s', async (_name, efforts) => {
    const { ctx, streamed } = setup(textResponse('好'), efforts)
    await createModelCall(ctx, { provider: 'p', model: 'm', maxOutputTokens: 100 })(request, new AbortController().signal)
    expect(streamed[0]).not.toHaveProperty('reasoningEffort')
  })

  it('follows the default route of the event profile, with its reasoning effort when it has one', async () => {
    const withEffort = setup(textResponse('好'), undefined, { selection: { provider: 'dp', model: 'dm', reasoningEffort: 'low' } })
    await createModelCall(withEffort.ctx, { maxOutputTokens: 100 })(request, new AbortController().signal)
    expect(withEffort.streamed[0]).toMatchObject({ provider: 'dp', model: 'dm', reasoningEffort: 'low' })
    const plain = setup(textResponse('好'), undefined, { selection: { provider: 'dp', model: 'dm' } })
    await createModelCall(plain.ctx, { provider: 'only-provider', maxOutputTokens: 100 })(request, new AbortController().signal)
    expect(plain.streamed[0]).toMatchObject({ provider: 'dp', model: 'dm' })
    expect(plain.streamed[0]).not.toHaveProperty('reasoningEffort')
  })

  it('rejects when the LLM service is not mounted or no route exists', async () => {
    const unmounted = setup([], undefined, { llm: undefined })
    await expect(createModelCall(unmounted.ctx, { maxOutputTokens: 1 })(request, new AbortController().signal)).rejects.toThrow('the LLM service is not mounted')
    const noRoute = setup([], undefined, { selection: undefined })
    await expect(createModelCall(noRoute.ctx, { maxOutputTokens: 1 })(request, new AbortController().signal)).rejects.toThrow('no model route')
  })

  it('accepts an answer cut off at the output cap', async () => {
    const { ctx } = setup(maxTokensResponse('半句'), undefined, { selection: { provider: 'dp', model: 'dm' } })
    expect((await createModelCall(ctx, { maxOutputTokens: 1 })(request, new AbortController().signal)).text).toBe('半句')
  })

  it.each([
    ['error', { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } }, 'the model call ended with error (RATE_LIMIT: slow down)'],
    ['aborted', { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } }, 'the model call ended with aborted (ABORTED: stopped)'],
    ['tool-calls', { kind: 'tool-calls' }, 'the model call ended with tool-calls (tool-calls)'],
  ])('rejects a %s finish and carries the raw answer on the error', async (_name, reason, message) => {
    const { ctx } = setup([{ type: 'finish', reason } as StreamChunk], undefined, { selection: { provider: 'dp', model: 'dm' } })
    const call = createModelCall(ctx, { maxOutputTokens: 1 })
    const failure = await call(request, new AbortController().signal).catch((error: unknown) => error)
    expect((failure as Error).message).toBe(message)
    expect((failure as { raw: { finish: { kind: string } } }).raw.finish.kind).toBe(reason.kind)
  })

  it('stops reading when the caller aborts mid-stream', async () => {
    const controller = new AbortController()
    const { ctx } = setup(textResponse('不会读完'), undefined, { selection: { provider: 'dp', model: 'dm' } })
    controller.abort(new Error('cancelled by the owner'))
    await expect(createModelCall(ctx, { maxOutputTokens: 1 })(request, controller.signal)).rejects.toThrow('cancelled by the owner')
  })
})
