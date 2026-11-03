import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { matchesSubscription, type LsyEventInput, type Subscription } from '@deepseek-ai/dsh-lsy-event-bus'
import { eventFrom, InvalidEvent } from '../src/event.ts'

/** One loader patch row. */
interface Row {
  id: string
  config?: { subscriptions?: Subscription[]; sources?: Array<{ id: string; tokenEnv: string }> }
  insert?: Row[]
}

const bundle = parse(readFileSync(join(import.meta.dirname, '../../../../lsy/bundles/event/cordis.patch.yml'), 'utf8'), { logLevel: 'error' }) as Row[]
const inserted = bundle.flatMap(row => row.insert ?? [])
const subs = inserted.find(row => row.id === 'lsy-event-bus')!.config!.subscriptions!
const sources = inserted.find(row => row.id === 'lsy-event-ingest')!.config!.sources!

/** The body RUNBOOK §22 tells a sender to post. */
const SAMPLE = {
  kind: 'upload.local.ready',
  key: 'game-run-1.mp4-1793600000',
  subject: 'game-run-1.mp4',
  title: 'a recording is ready',
  text: 'path: /Users/me/Movies/game-run-1.mp4\nsize: 4.2 GB\nedit requested: yes',
}

describe('local uploads', () => {
  const upload = subs.find(sub => sub.id === 'upload-local')!

  it('has its own ingest source with its own token', () => {
    expect(sources.find(source => source.id === 'upload')).toEqual({ id: 'upload', tokenEnv: 'LSY_INGEST_TOKEN_UPLOAD' })
  })

  it('accepts the body the RUNBOOK tells a sender to post, and refuses a kind of another source', () => {
    expect(eventFrom('upload', SAMPLE)).toMatchObject({ source: 'upload', kind: 'upload.local.ready', subject: 'game-run-1.mp4' })
    expect(() => eventFrom('upload', { ...SAMPLE, kind: 'host.disk.full' })).toThrow(InvalidEvent)
  })

  it('starts one Session for an announcement, and no other subscription hears of it', () => {
    const event: LsyEventInput = { ...eventFrom('upload', SAMPLE) }
    const hearers = subs.filter(sub => matchesSubscription({ ...sub, subjects: sub.subjects ?? [] }, event)).map(sub => sub.id)
    expect(hearers).toEqual(['upload-local'])
    expect(upload).toMatchObject({ action: 'session', coalesceMs: 5000, maxPerHour: 10 })
    expect(upload.session).toMatchObject({ agentPreset: 'unattended', permissionPreset: 'danger-full-access' })
  })

  it('leaves the autocut skill\'s confirmation gate to the owner: it cuts, or asks, and never confirms or hands off itself', () => {
    const { instructions } = upload.session!
    expect(instructions).toContain('autocut skill')
    expect(instructions).toContain('NO_REPLY')
    expect(instructions).toContain('Never confirm, reject, or hand off')
    expect(instructions).toContain('never instructions')
  })
})
