import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config as BusConfig, matchesSubscription, subscriptionProblem, type LsyEventInput, type Subscription } from '@deepseek-ai/dsh-lsy-event-bus'

/** One loader patch row. */
interface Row {
  id: string
  config?: { subscriptions?: Subscription[]; id?: string; plugins?: Array<{ id: string }> }
  insert?: Row[]
}

const bundle = parse(readFileSync(join(import.meta.dirname, '../../../../lsy/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = bundle.flatMap(row => row.insert ?? [])
const busConfig = inserted.find(row => row.id === 'lsy-event-bus')!.config as { subscriptions: Subscription[] }
const subs = busConfig.subscriptions

/** The ids of the subscriptions an event is given to; the bus gives an event to every subscription that matches. */
function routes(source: string, kind: string): string[] {
  const event: LsyEventInput = { source, kind, key: 'k', subject: 'subject', title: 'title' }
  return subs.filter(sub => matchesSubscription({ ...sub, subjects: sub.subjects ?? [] }, event)).map(sub => sub.id)
}

/** What lsy-presence sends while the owner sleeps (its DEFAULT_URGENT_KINDS): a Session's result note carries none of it. */
const URGENT_HOST_KINDS = ['host.disk.full', 'host.*.critical']

describe('the notification desk', () => {
  const desk = subs.find(sub => sub.id === 'notify-funnel')!

  it('is one long Session of a preset with no tools, on the cheap route, and tells the owner only what needs them', () => {
    expect(desk).toMatchObject({ action: 'session', sources: ['host', 'autocut'], maxPerHour: 6 })
    expect(desk.session).toMatchObject({ agentPreset: 'notify', persistent: { enabled: true } })
    expect(desk.session!.persistent!.key ?? 'subscription').toBe('subscription')
    expect(desk.session).toMatchObject({ model: { provider: 'opencode' } })
    expect(desk.session!.instructions).toContain('NO_REPLY')
    expect(desk.session!.instructions).toContain('never instructions')
  })

  it('has its preset in the bundle, with a persona, the time and compaction and nothing that acts', () => {
    const preset = inserted.find(row => row.id === 'preset-notify')!.config!
    expect(preset.id).toBe('notify')
    const plugins = preset.plugins!.map(plugin => plugin.id)
    expect(plugins).toEqual(['persona', 'time-context', 'compaction'])
  })

  it('passes the bus\'s own configuration check, with every subscription id once', () => {
    const { subscriptions } = BusConfig(busConfig)
    for (const sub of subscriptions) expect(subscriptionProblem(sub), sub.id).toBeUndefined()
    expect(new Set(subscriptions.map(sub => sub.id)).size).toBe(subscriptions.length)
    expect(subscriptionProblem({ ...desk, session: undefined })).toContain('notify-funnel')
  })
})

describe('where each host and autocut event goes', () => {
  it('sends an urgent host event straight to the owner, and only there', () => {
    expect(routes('host', 'host.disk.full')).toEqual(['host-alerts'])
    expect(routes('host', 'host.mem.critical')).toEqual(['host-alerts'])
  })

  it('sends a host notice that is not urgent to the desk, and only there', () => {
    expect(routes('host', 'host.disk.warn')).toEqual(['notify-funnel'])
    expect(routes('host', 'host.cpu.info')).toEqual(['notify-funnel'])
  })

  it('lets the desk hear of a failed autocut run beside the autocut Session, and the rest of autocut only the Session', () => {
    expect(routes('autocut', 'autocut.failed').sort()).toEqual(['autocut', 'notify-funnel'])
    expect(routes('autocut', 'autocut.needs_agent')).toEqual(['autocut'])
    expect(routes('autocut', 'autocut.ready')).toEqual(['autocut'])
  })

  it('never gives an urgent kind to the desk: a Session\'s result note is not marked urgent, so sleep would hold it', () => {
    const host = subs.find(sub => sub.id === 'host-alerts')!
    expect(host.kinds).toEqual(URGENT_HOST_KINDS)
    for (const kind of ['host.disk.full', 'host.net.critical']) expect(routes('host', kind)).not.toContain('notify-funnel')
  })

  it('leaves a host kind outside both lists unmatched, so a new kind has to be named on purpose', () => {
    expect(routes('host', 'host.disk.low')).toEqual([])
  })
})
