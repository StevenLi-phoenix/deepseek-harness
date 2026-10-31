/**
 * Whole path with no model: a QQ user's message goes over the (stand-in) gateway WebSocket into the real SDK
 * transport and the channel, reaches a chat Session, and the Session's answer leaves through owner-relay and
 * the SDK's message API. Only the platform and the Session Controller are doubles.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import OwnerRelay from '@deepseek-ai/dsh-owner-relay'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import QqChannel, { Config } from '../src/index.ts'
import { createSdkTransport } from '../src/transport.ts'
import { FakeOpenPlatform } from './fake-platform.ts'

const USER = 'E4D1A2B3C4D5E6F708192A3B4C5D6E7F'
const STRANGER = '0000FFFF1111EEEE2222DDDD3333CCCC'
const GROUP = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const MEMBER = '9F8E7D6C5B4A39281706F5E4D3C2B1A0'

let dir: string
const cleanups: Array<() => Promise<void>> = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lsy-qq-e2e-')) })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function boot() {
  const platform = new FakeOpenPlatform()
  await platform.listen()
  cleanups.push(() => platform.close())
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push(String(message.args[0])) } })
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const prompts: SessionPromptRequest[] = []
  ctx.provide('sessionController', {
    create: async () => ({ sessionId: 'qq-1' }),
    resolveAgent: async (sessionId: string) => ({ agent: { session: { id: sessionId } } }),
    prompt: async (request: SessionPromptRequest) => { prompts.push(request); return { accepted: true } },
  } as never)
  ctx.provide('permissionPresets', { resolve: () => ({}), set: () => {} } as never)
  ctx.provide('sessionTitle', { rename: () => {}, get: () => undefined } as never)
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve({ value: ref === 'LSY_QQ_APP_ID' ? '1020304050' : 'secret-0123456789' }) } as never)
  ctx.provide('lsyQqTransport', createSdkTransport({
    appId: '1020304050', appSecret: 'secret-0123456789', baseUrl: platform.origin, tokenBaseUrl: platform.origin, log: { debug: () => {}, warn: () => {} },
  }) as never)
  const notes: unknown[] = []
  ctx.provide('lsyNotifier', { send: async (note: unknown) => { notes.push(note) } } as never)
  await ctx.plugin(OwnerRelay)
  await ctx.plugin(QqChannel, Config({ allow: { users: [USER], groups: [GROUP] }, session: { workspacePath: join(dir, 'qq') } } as never))
  await until(() => platform.identifies.length > 0, 'the gateway identify')
  await until(() => logs.some(line => line.includes('connected to the QQ gateway')), 'READY')
  const emit = (event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: 'qq-1' }, event) }
  const answer = (text: string): void => {
    emit({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } })
    emit({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  }
  const messages = (): Array<{ url: string; body: Record<string, unknown> }> =>
    platform.requests.filter(request => request.url.endsWith('/messages')).map(request => ({ url: request.url, body: request.body as Record<string, unknown> }))
  return { platform, prompts, notes, answer, messages, logs }
}

describe('QQ channel end to end', () => {
  it('takes a private message from the gateway to the agent and the answer back through the message API', async () => {
    const h = await boot()
    h.platform.dispatch('C2C_MESSAGE_CREATE', { id: 'ROBOT1.0_c2c-1', content: '你好', timestamp: '2026-10-30T10:00:00+08:00', author: { user_openid: USER } }, 2)
    await until(() => h.prompts.length === 1, 'the prompt')
    expect(h.prompts[0]).toMatchObject({ sessionId: 'qq-1', mode: 'steer', content: [{ type: 'text', text: '[QQ 私聊 · 5D6E7F] 你好' }] })

    h.answer('你好呀，有什么事？')
    await until(() => h.messages().length === 1, 'the reply')
    expect(h.messages()[0]).toMatchObject({ url: `/v2/users/${USER}/messages`, body: { content: '你好呀，有什么事？', msg_type: 0, msg_id: 'ROBOT1.0_c2c-1' } })
  })

  it('does the same for a group @ mention, in the group', async () => {
    const h = await boot()
    h.platform.dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: 'ROBOT1.0_grp-1', content: ' 帮我看下', timestamp: '2026-10-30T10:00:01+08:00', group_openid: GROUP, author: { member_openid: MEMBER },
    }, 2)
    await until(() => h.prompts.length === 1, 'the prompt')
    expect(h.prompts[0]!.content[0]).toEqual({ type: 'text', text: '[QQ 群 7E8F90 · 成员 C2B1A0] 帮我看下' })
    h.answer('好的')
    await until(() => h.messages().length === 1, 'the reply')
    expect(h.messages()[0]).toMatchObject({ url: `/v2/groups/${GROUP}/messages`, body: { content: '好的', msg_id: 'ROBOT1.0_grp-1' } })
  })

  it('answers nobody outside the lists: no Session, no reply, one note to the owner', async () => {
    const h = await boot()
    h.platform.dispatch('C2C_MESSAGE_CREATE', { id: 'ROBOT1.0_c2c-9', content: '在吗', timestamp: '2026-10-30T10:00:00+08:00', author: { user_openid: STRANGER } }, 2)
    h.platform.dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: 'ROBOT1.0_grp-9', content: 'hi', timestamp: '2026-10-30T10:00:01+08:00', group_openid: 'OTHERGROUP', author: { member_openid: STRANGER },
    }, 3)
    await until(() => h.notes.length === 2, 'both notes')
    expect(h.prompts).toEqual([])
    expect(h.messages()).toEqual([])
    expect(JSON.stringify(h.notes[0])).toContain(STRANGER)
  })
})
