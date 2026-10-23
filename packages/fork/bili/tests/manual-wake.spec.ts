import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BiliView } from '../src/view.ts'
import { FakeBili } from './fake-bili.ts'
import { allLogs, contexts, fakeSessions, harness } from './harness.ts'

const PRICING = [{
  providers: ['deepseek-official'],
  peak: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '01:00', end: '04:00' }, { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '06:00', end: '10:00' }],
}]

let dir: string
let fake: FakeBili

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bili-manual-'))
  fake = new FakeBili()
  vi.useFakeTimers()
  // Fri 2026-10-23 10:00 in New York (EDT), off-peak for DeepSeek.
  vi.setSystemTime(new Date('2026-10-23T14:00:00.000Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
  allLogs.splice(0)
})

const wakeNow = async (h: Awaited<ReturnType<typeof harness>>): Promise<BiliView> => await (await h.post({ action: 'wake' })).json() as BiliView

describe('manual wake', () => {
  it('prompts the Session once with the body-clock prompt, leaves the plan alone, and debounces a double click', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir, config: { interests: '猫' } })
    await h.signIn()
    const planned = (await h.view()).clock.today
    // The action rides the one signed-in route; nothing else is registered.
    expect(h.routes.map(route => [route.path, route.methods])).toEqual([['/api/bili', ['GET', 'POST']]])
    const view = await wakeNow(h)
    expect(view.manualWake).toEqual({ at: expect.any(Number) as unknown, outcome: 'started' })
    expect(sessions.state.prompts).toHaveLength(1)
    const text = (sessions.state.prompts[0]!.content[0] as { text: string }).text
    expect(text).toMatch(/^Body clock: you wake up at Fri 2026-10-23 10:\d\d \(America\/New_York\)\. This is your first wake\.\n/)
    expect(text).toContain('\nWrites left today: ')
    expect(text).toContain('The owner\'s interests, as they wrote them: 猫')
    expect(view.clock.today).toEqual(planned)
    expect(view.clock.lastWake).toMatchObject({ reason: 'manual' })
    expect(h.logs.some(line => line.text === 'bili: the owner woke the Session (bili-1) from Settings')).toBe(true)

    const again = await wakeNow(h)
    expect(again.manualWake).toMatchObject({ outcome: 'refused', reason: 'recent' })
    expect(sessions.state.prompts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(61_000)
    expect((await wakeNow(h)).manualWake).toMatchObject({ outcome: 'started' })
    expect(sessions.state.prompts).toHaveLength(2)
  })

  it('refuses while signed out, while the login needs renewing, and while the Session runs a turn', async () => {
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir })
    expect((await wakeNow(h)).manualWake).toMatchObject({ outcome: 'refused', reason: 'signed-out' })
    await h.signIn()
    sessions.state.status.set('bili-1', 'running')
    expect((await wakeNow(h)).manualWake).toMatchObject({ outcome: 'refused', reason: 'busy' })
    expect(sessions.state.prompts).toEqual([])
    // A refused attempt does not hold the debounce.
    sessions.state.status.set('bili-1', 'idle')
    expect((await wakeNow(h)).manualWake).toMatchObject({ outcome: 'started' })
    fake.session = undefined
    await vi.advanceTimersByTimeAsync(70_000)
    expect((await h.view()).account.state).toBe('login-needed')
    expect((await wakeNow(h)).manualWake).toMatchObject({ outcome: 'refused', reason: 'login-needed' })
    expect(h.logs.filter(line => line.text.startsWith('bili: manual wake refused')).length).toBe(3)
  })

  it('wakes even in a priced peak or a read back-off, and says so', async () => {
    // Fri 2026-10-23 07:00 UTC is inside DeepSeek's 06:00–10:00 peak.
    vi.setSystemTime(new Date('2026-10-23T07:00:00.000Z'))
    const sessions = fakeSessions()
    const h = await harness({ bili: fake, sessions, workspace: dir, defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, config: { pricing: PRICING } })
    await h.signIn()
    fake.reply('/x/web-interface/popular', { status: 412 })
    await expect(h.run(h.account.popular())).rejects.toThrow('risk control')
    const view = await wakeNow(h)
    expect(view.manualWake).toEqual({
      at: expect.any(Number) as unknown,
      outcome: 'started',
      peak: { provider: 'deepseek-official', offPeakAt: Date.parse('2026-10-23T10:00:00Z') },
      readsResumeAt: view.readsResumeAt,
    })
    expect(sessions.state.prompts).toHaveLength(1)
    expect(h.logs.some(line => line.text === 'bili: the owner woke the Session (bili-1) from Settings, in a peak period of deepseek-official; reads are backing off')).toBe(true)
  })
})
