import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

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

describe('warnings no longer have a DSH source', () => {
  it('has no warn source or subscription: warnings go to the AMS intake and reach the agent through the journal Monitor', () => {
    expect(sources.map(source => source.id)).not.toContain('warn')
    expect(subs.map(sub => sub.id)).not.toContain('warn')
    expect(JSON.stringify(inserted)).not.toContain('LSY_INGEST_TOKEN_WARN')
    for (const id of ['kaorou', 'operator', 'host', 'autocut', 'bili']) expect(sources.map(source => source.id)).toContain(id)
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
})
