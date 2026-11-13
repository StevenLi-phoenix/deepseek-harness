/** Real Loader composition of the auto-archive: a test-only cordis.yml mounts the bus through its shipped exports. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as busModule from '../src/index.ts'
import { fakeController, fakeRegistry } from './harness.ts'

const DAY = 86_400_000

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('auto-archive through the real Loader', () => {
  it('archives an old idle Session, keeps the protected ones, and a config change rebuilds the timer and the protector registry', { timeout: 60_000 }, async () => {
    expect('default' in busModule).toBe(true)
    root = await mkdtemp(join(tmpdir(), 'dsh-bus-archive-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: fixture-storage',
      '- name: fixture-hosts',
      '- name: fixture-timer',
      '- id: bus',
      "  name: '@deepseek-ai/dsh-event-bus'",
      '  config:',
      '    autoArchive:',
      '      inactiveDays: 7',
      '      firstSweepMinutes: 0',
      '      sweepHours: 1',
      '- name: fixture-channel',
      '',
    ].join('\n'))

    const now = Date.now()
    const controller = fakeController()
    const row = (id: string, days: number, running = false) => ({ sessionId: id, updatedAt: now - days * DAY, running, blank: false })
    controller.rows.push(row('old-chat', 30), row('wechat-main', 30), row('qq-resident', 30), row('fresh', 1), row('mid-turn', 30, true))
    const registry = fakeRegistry()
    registry.pinnedSessionIds.push('pinned-note')
    controller.rows.push(row('pinned-note', 30))

    const pool = new MemoryMediaPool()
    const hosts = {
      name: 'fixture-hosts',
      inject: ['storage'],
      apply(ctx: Context) {
        const backend = new MemoryStorageBackend(pool)
        ctx.effect(() => ctx.storage.backend.register('fixture', backend))
        const facility = new DomainFacility(ctx, { backend: 'fixture' })
        ctx.effect(() => {
          const unmount = ctx.storage.mount('domain', facility)
          ctx.provide('storageDomain', facility)
          return async () => { await facility.closeAll(); unmount() }
        })
        ctx.provide('sessionController' as never, controller as never)
        ctx.provide('workspaceRegistry' as never, registry as never)
      },
    }
    // What wechat and qq do: claim their own Sessions once the bus is mounted, withdraw on reload.
    const registrations: string[] = []
    const channel = {
      name: 'fixture-channel',
      inject: ['eventBus'],
      apply(ctx: Context) {
        ctx.effect(() => {
          registrations.push('mount')
          const wechat = ctx.eventBus.protectSessions('wechat', session => session.id === 'wechat-main')
          const qq = ctx.eventBus.protectSessions('qq', session => (session.id === 'qq-resident' ? 'resident group' : undefined))
          return () => { registrations.push('unmount'); wechat(); qq() }
        }, 'fixture.channel()')
      },
    }
    const modules = new Map<string, unknown>([
      ['fixture-storage', Storage],
      ['fixture-hosts', hosts],
      ['fixture-timer', Timer],
      ['@deepseek-ai/dsh-event-bus', busModule],
      ['fixture-channel', channel],
    ])

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    Reflect.set(context.loader, 'internal', {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    })
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    // The schema filled the block in; the first sweep ran at once (firstSweepMinutes: 0).
    await vi.waitFor(() => { expect(registry.archivedSessionIds).toEqual(['old-chat']) })
    const first = context.eventBus
    expect(first.archiveStatus()).toMatchObject({
      enabled: true, dryRun: false, inactiveDays: 7, maxPerSweep: 50, sweepHours: 1, protectors: ['wechat', 'qq'],
      lastSweep: { archived: ['old-chat'], skipped: { recent: 1, running: 1, pinned: 1, wechat: 1, qq: 1 } },
      recent: [{ sessionId: 'old-chat' }],
    })
    expect(first.archiveStatus().nextSweepAt).toBeGreaterThan(now)

    // A config change reloads the bus: the old instance's timer and protectors are gone, the channel registers again on the new one.
    const archivedBefore = [...registry.archivedSessionIds]
    const busEntry = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-event-bus')!
    await context.loader.update(busEntry.id, { config: { autoArchive: { inactiveDays: 3, firstSweepMinutes: 60, sweepHours: 1 } } })
    await context.loader.await()
    const second = context.eventBus
    expect(second).not.toBe(first)
    expect(first.archiveStatus().nextSweepAt).toBeUndefined()
    expect(first.archiveStatus().protectors).toEqual([])
    expect(second.archiveStatus()).toMatchObject({ inactiveDays: 3, protectors: ['wechat', 'qq'] })
    expect(registrations.filter(entry => entry === 'mount').length).toBeGreaterThanOrEqual(2)
    expect(registrations).toContain('unmount')
    expect(registry.archivedSessionIds).toEqual(archivedBefore)
  })
})
