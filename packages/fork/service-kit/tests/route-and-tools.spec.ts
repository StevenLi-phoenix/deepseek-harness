/** A JSON Settings route's body and errors, and the JSON tools' output. */
import { describe, expect, it } from 'vitest'
import { ERROR_SCHEMA, jsonFailure, NO_STORE, readJsonAction, readJsonBody, renderJson, renderWrapped } from '../src/index.ts'

const post = (body: string, type = 'application/json'): Request => new Request('http://127.0.0.1/api/x', { method: 'POST', headers: { 'content-type': type }, body })

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    expect(await readJsonBody(post('{"action":"a"}'))).toEqual({ ok: true, body: { action: 'a' } })
    expect(await readJsonBody(post('[]', 'application/json; charset=utf-8'))).toEqual({ ok: true, body: [] })
  })

  it('answers 415 without a JSON type and 400 for a body that is not JSON, never cached', async () => {
    const wrongType = await readJsonBody(post('{}', 'text/plain'))
    const noType = await readJsonBody(new Request('http://127.0.0.1/api/x', { method: 'POST', body: new Uint8Array([1]) }))
    const broken = await readJsonBody(post('{secret'))
    for (const [read, status, error] of [[wrongType, 415, 'expected application/json'], [noType, 415, 'expected application/json'], [broken, 400, 'body is not JSON']] as const) {
      expect(read.ok).toBe(false)
      if (read.ok) continue
      expect(read.answer.status).toBe(status)
      expect(read.answer.headers.get('cache-control')).toBe('no-store')
      expect(await read.answer.json()).toEqual({ error })
    }
  })
})

describe('readJsonAction', () => {
  const parse = (body: unknown): { action: string } => {
    if (typeof body !== 'object' || body === null || !('action' in body) || typeof body.action !== 'string') throw new Error(`bad body ${JSON.stringify(body)}`)
    return { action: body.action }
  }

  it('answers the action the schema accepts, the body errors as they are, and a refusal without the schema\'s words', async () => {
    expect(await readJsonAction(post('{"action":"go"}'), parse, 'unknown action')).toEqual({ ok: true, action: { action: 'go' } })
    const notJson = await readJsonAction(post('nope'), parse, 'unknown action')
    expect(notJson.ok ? undefined : notJson.answer.status).toBe(400)
    const refused = await readJsonAction(post('{"code":"123456"}'), parse, 'unknown action')
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.answer.status).toBe(400)
    expect(await refused.answer.text()).toBe('{"error":"unknown action"}')
  })
})

describe('jsonFailure', () => {
  it('answers the reason with the status, never cached', async () => {
    const answer = jsonFailure(409, 'no bot is bound')
    expect(answer.status).toBe(409)
    expect(answer.headers.get('cache-control')).toBe(NO_STORE['cache-control'])
    expect(await answer.json()).toEqual({ error: 'no bot is bound' })
  })
})

describe('tool output', () => {
  it('declares the refusal schema', () => {
    expect(ERROR_SCHEMA).toEqual({ type: 'object', additionalProperties: false, properties: { error: { type: 'string', required: true } } })
  })

  it('renders a value as JSON, and wraps a value unless it is a refusal', () => {
    expect(renderJson({}, { a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }])
    const render = renderWrapped(value => `<data>${JSON.stringify(value)}</data>`)
    expect(render({}, { items: [1] })).toEqual([{ type: 'text', text: '<data>{"items":[1]}</data>' }])
    expect(render({}, { error: 'bili-svc is unreachable' })).toEqual([{ type: 'text', text: '{"error":"bili-svc is unreachable"}' }])
    expect(render({}, { error: 42 })).toEqual([{ type: 'text', text: '<data>{"error":42}</data>' }])
    expect(render({}, null)).toEqual([{ type: 'text', text: '<data>null</data>' }])
  })
})
