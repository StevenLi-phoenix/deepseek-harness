/** Moving one Session's tasks to another: destinations, involved Sessions, archive admission, notices, and repeat calls. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentFor, harness, type HarnessAgent } from './harness.ts'

const active: Awaited<ReturnType<typeof harness>>[] = []
const daily = 'DTSTART:20260916T010000Z\nRRULE:FREQ=DAILY'
const OLD = SessionId('old-chat')
const OLDER = SessionId('older-chat')
const NEW = SessionId('new-chat')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-09-16T00:00:00Z') })
afterEach(async () => {
  await Promise.all(active.splice(0).map(test => test.ctx.fiber.dispose()))
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  const test = await harness()
  active.push(test)
  const create = (title: string, sessionId: SessionId, actor?: SessionId) => test.service.create({
    title, prompt: 'Prompt', timing: { kind: 'rrule', rrule: daily }, target: { kind: 'session', sessionId },
  }, actor)
  const activity = (sessionId: SessionId) =>
    test.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  return { ...test, create, activity }
}

/** Text of every change notice queued for one live Agent. */
function notices(agent: HarnessAgent): string[] {
  return agent.inject.mock.calls.map(([message]) => message.content.map(part => part.type === 'text' ? part.text : '').join(''))
}

it('moves active and paused tasks of the old Sessions to the new one and leaves the rest alone', async () => {
  const test = await setup()
  const reminder = await test.create('Weekly homework', OLD, OLD)
  const paused = await test.create('Paused check', OLDER)
  await test.service.edit({ id: paused.id, action: 'update', patch: { active: false } })
  // Created by the old chat, delivered elsewhere: only the involvement moves.
  const elsewhere = await test.create('Elsewhere', SessionId('other'), OLD)
  const unrelated = await test.create('Unrelated', SessionId('other'))

  vi.setSystemTime('2026-09-16T00:00:05Z')
  const moved = await test.service.handOverSessions([OLD, OLDER, NEW], NEW)

  expect(moved.map(entry => entry.title).toSorted()).toEqual(['Elsewhere', 'Paused check', 'Weekly homework'])
  const view = async (id: typeof reminder.id) => test.service.view({ id })
  expect(await view(reminder.id)).toMatchObject({ target: { kind: 'session', sessionId: NEW }, involvedSessionIds: [NEW], status: 'active' })
  expect(await view(paused.id)).toMatchObject({ target: { kind: 'session', sessionId: NEW }, involvedSessionIds: [NEW], status: 'paused' })
  expect(await view(elsewhere.id)).toMatchObject({
    target: { kind: 'session', sessionId: SessionId('other') }, involvedSessionIds: [NEW, SessionId('other')],
  })
  expect(await view(unrelated.id)).toEqual(unrelated)
  // The old chat no longer holds work, so archiving it is clean; the new one holds the active task.
  expect(await test.activity(OLD)).toEqual([])
  expect(await test.activity(NEW)).toEqual([{ kind: 'schedule', items: [{ id: reminder.id, label: 'Weekly homework' }] }])
})

it('tells the live new Session about each moved task and does nothing on a repeat', async () => {
  const test = await setup()
  const next = agentFor(test.ctx, NEW)
  await test.ctx.agents.register(next)
  const reminder = await test.create('Weekly homework', OLD)
  const before = await test.service.view({ id: reminder.id })

  await test.service.handOverSessions([OLD], NEW)
  await vi.waitFor(() => { expect(next.inject).toHaveBeenCalledOnce() })
  expect(notices(next)).toEqual([expect.stringContaining('change: updated')])
  const after = await test.service.view({ id: reminder.id })
  expect(after).not.toEqual(before)

  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.handOverSessions([OLD], NEW)).toEqual([])
  expect(await test.service.view({ id: reminder.id })).toEqual(after)
  expect(changed).not.toHaveBeenCalled()
})

it('refuses an archived destination and changes nothing', async () => {
  const test = await setup()
  const reminder = await test.create('Weekly homework', OLD)
  test.ctx.provide('workspaceRegistry', { archivedSessionIds: [NEW] } as never)
  await expect(test.service.handOverSessions([OLD], NEW)).rejects.toThrow(/archived/)
  expect(await test.service.view({ id: reminder.id })).toEqual(reminder)
})

it('answers an empty list when nothing involves the old Sessions', async () => {
  const test = await setup()
  await test.create('Unrelated', SessionId('other'))
  expect(await test.service.handOverSessions([OLD], NEW)).toEqual([])
  expect(await test.service.handOverSessions([], NEW)).toEqual([])
})
