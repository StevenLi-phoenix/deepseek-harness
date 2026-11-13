import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchesSubscription, type Subscription } from '@deepseek-ai/dsh-event-bus'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { Config } from '../src/index.ts'
import { KIND_SLEEP_OFF, KIND_SLEEP_ON, PRESENCE_SOURCE } from '../src/view.ts'

/** One loader patch row. */
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown> & { sources?: Array<{ id: string; tokenEnv: string; sink?: string }>; subscriptions?: Subscription[] }
  insert?: Row[]
}

const bundle = parse(readFileSync(join(import.meta.dirname, '../../../../fork/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = bundle.flatMap(row => row.insert ?? [])
const row = (id: string): Row => inserted.find(entry => entry.id === id)!

describe('event bundle', () => {
  it('mounts presence in the owner\'s time zone', () => {
    const presence = row('presence')
    expect(presence.name).toBe('@deepseek-ai/dsh-presence')
    expect(presence.config).toEqual({ timeZone: 'America/New_York' })
    expect(Config(presence.config as never)).toMatchObject({ focusFreshHours: 2 })
  })

  it('declares the presence ingest source as a sink of ctx.presence', () => {
    const source = row('event-ingest').config!.sources!.find(entry => entry.id === PRESENCE_SOURCE)
    expect(source).toEqual({ id: 'presence', tokenEnv: 'EVENT_INGEST_TOKEN_PRESENCE', sink: 'presence' })
  })

  it('has no subscription that could match a presence event, so none starts a Session or sends a note', () => {
    const subscriptions = row('event-bus').config!.subscriptions!
    for (const kind of [KIND_SLEEP_ON, KIND_SLEEP_OFF]) {
      const event = { source: PRESENCE_SOURCE, kind, key: 'k', subject: 'owner', title: 't' }
      const matching = subscriptions.filter(subscription => matchesSubscription(subscription, event))
      expect(matching.map(subscription => subscription.id)).toEqual([])
    }
  })
})
