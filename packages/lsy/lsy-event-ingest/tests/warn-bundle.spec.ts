import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { eventFrom } from '../src/event.ts'

/** One loader patch row. */
interface Row {
  id: string
  config?: { subscriptions?: Subscription[]; sources?: Array<{ id: string; tokenEnv: string }> }
  insert?: Row[]
}

interface Subscription {
  id: string
  sources: string[]
  kinds: string[]
  subjects?: string[]
  action: 'notify' | 'session'
  coalesceMs: number
  maxPerHour: number
  session?: { agentPreset: string; workspacePath: string; permissionPreset: string; instructions: string; trustedText?: boolean }
}

const bundle = parse(readFileSync(join(import.meta.dirname, '../../../../lsy/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = bundle.flatMap(row => row.insert ?? [])
const subs = inserted.find(row => row.id === 'lsy-event-bus')!.config!.subscriptions!
const sources = inserted.find(row => row.id === 'lsy-event-ingest')!.config!.sources!

describe('unified warning intake in the event bundle', () => {
  it('accepts warn events from its own source token and keeps the existing sources', () => {
    expect(sources).toContainEqual({ id: 'warn', tokenEnv: 'LSY_INGEST_TOKEN_WARN' })
    for (const id of ['kaorou', 'operator', 'host', 'autocut', 'bili']) expect(sources.map(source => source.id)).toContain(id)
    expect(new Set(sources.map(source => source.tokenEnv)).size).toBe(sources.length)
  })

  it('hands every warn.* event to one unattended session that defaults to NO_REPLY', () => {
    const warn = subs.find(sub => sub.id === 'warn')!
    expect(warn).toMatchObject({ sources: ['warn'], kinds: ['warn.*'], action: 'session', coalesceMs: 120_000, maxPerHour: 6 })
    expect(warn.session).toMatchObject({ agentPreset: 'unattended' })
    // Pushed text is data: the owner-request framing is for the operator source only.
    expect(warn.session!.trustedText).not.toBe(true)
    const text = warn.session!.instructions
    for (const needle of ['NO_REPLY', 'three sentences', 'Chinese', 'read-only']) expect(text).toContain(needle)
  })

  it('subscribes to finished CI runs of the owner\'s repositories, four sessions an hour, successes silent', () => {
    const ci = subs.find(sub => sub.id === 'ci')!
    expect(ci).toMatchObject({ sources: ['github'], kinds: ['github.workflow_run.completed'], action: 'session', maxPerHour: 4 })
    expect(ci.subjects).toEqual(['StevenLi-phoenix/*'])
    expect(ci.session).toMatchObject({ agentPreset: 'unattended' })
    expect(ci.session!.instructions).toContain('NO_REPLY')
    expect(ci.session!.instructions).toContain('success')
  })

  it('does not use global suppress markers, which match any output substring', () => {
    const bus = inserted.find(row => row.id === 'lsy-event-bus')!.config as { suppress?: { markers?: string[] } }
    expect(bus.suppress?.markers).toEqual([])
  })

  it('routes warn events to exactly one subscription', () => {
    expect(subs.filter(sub => sub.sources.includes('warn')).map(sub => sub.id)).toEqual(['warn'])
  })

  it('takes the kinds the warn CLI generates, and refuses a kind outside its source', () => {
    for (const kind of ['warn.n8.info', 'warn.phm.docker.error', 'warn.laptop-stevenli.crit', 'warn.systemd.core-api_service.error']) {
      expect(eventFrom('warn', { kind, key: 'k', subject: 's', title: 't' })).toMatchObject({ source: 'warn', kind })
    }
    expect(() => eventFrom('warn', { kind: 'host.disk.full', key: 'k', subject: 's', title: 't' })).toThrow(/starting with "warn\."/)
  })
})
