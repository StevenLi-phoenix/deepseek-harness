import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerStyleTools, type LookupAnswer, type StyleTool, type ToolSink, type WriteAnswer } from '../src/tools.ts'

interface Exec { agent?: { session: { id: string; header: { agentPreset?: string } } } }

interface Registered {
  name: string
  execute: (args: Record<string, unknown>, exec: Exec) => Promise<unknown>
  presentCall: (args: Record<string, unknown>) => unknown
}

function mountTools(tools: readonly StyleTool[], perTurn: number, sink: () => ToolSink | undefined) {
  const registered = new Map<string, Registered>()
  const listeners: Array<(session: { id: string }, event: { type: string }) => void> = []
  const ctx = {
    tools: { register: (def: Registered) => { registered.set(def.name, def) } },
    on: (_event: string, listener: (typeof listeners)[number]) => { listeners.push(listener) },
  } as never as Context
  registerStyleTools(ctx, tools, perTurn, sink)
  const turn = (id: string, type: string): void => { for (const listener of listeners) listener({ id }, { type }) }
  return { tool: (name: string) => registered.get(name)!, names: [...registered.keys()], turn }
}

const recorded: WriteAnswer = { status: 'recorded' }
const miss: LookupAnswer = { found: false }
/** A sink whose three calls are recorded, each answering `recorded` (or not found) unless overridden. */
function sinkOf(overrides: { lookup?: ToolSink['lookup'] } = {}) {
  const note = vi.fn<ToolSink['note']>(async () => recorded)
  const updateCard = vi.fn<ToolSink['updateCard']>(async () => recorded)
  const lookup = vi.fn<ToolSink['lookup']>(overrides.lookup ?? (async () => miss))
  const sink: ToolSink = { note, lookup, updateCard }
  return { sink, note, lookup, updateCard }
}
const agent = (id: string, preset?: string) => ({ agent: { session: { id, header: preset === undefined ? {} : { agentPreset: preset } } } })

describe('registerStyleTools', () => {
  const call = (mounted: ReturnType<typeof mountTools>, name: string, args: Record<string, unknown>, exec: Exec = {}) =>
    mounted.tool(name).execute(args, exec)

  it('mounts only the listed tools', () => {
    expect(mountTools(['meme_lookup'], 2, () => undefined).names).toEqual(['meme_lookup'])
    expect(mountTools(['style_note', 'persona_update'], 2, () => undefined).names).toEqual(['style_note', 'persona_update'])
  })

  it('looks a meme up through the service, answers not found while it is not mounted, and presents the call', async () => {
    const { sink } = sinkOf({ lookup: async () => ({ found: true, from: 'groups', term: '梗', meaning: '意思' }) })
    const mounted = mountTools(['meme_lookup'], 2, () => sink)
    expect(await call(mounted, 'meme_lookup', { term: '梗' })).toMatchObject({ found: true, term: '梗' })
    expect(await call(mountTools(['meme_lookup'], 2, () => undefined), 'meme_lookup', { term: '梗' })).toEqual({ found: false })
    expect(mounted.tool('meme_lookup').presentCall({ term: '梗' }))
      .toEqual({ card: 'generic', title: 'Look up 梗', kind: 'search', rawInput: '梗' })
  })

  it('hands a note to the service with the Session, its preset, and only the fields given', async () => {
    const { sink, note } = sinkOf()
    const mounted = mountTools(['style_note'], 2, () => sink)
    expect(await call(mounted, 'style_note', { term: '嘴硬', example: '才不是', kind: 'trait' }, agent('s1', 'qq-digest'))).toEqual(recorded)
    expect(note.mock.lastCall![0]).toMatchObject({ sessionId: 's1', preset: 'qq-digest', kind: 'trait', term: '嘴硬', example: '才不是' })
    const first = note.mock.calls[0]![0]
    expect(first).not.toHaveProperty('meaning')
    expect(first).not.toHaveProperty('related')
    await call(mounted, 'style_note', { term: '梗', example: '例', meaning: '意思', related: ['孝子'] }, agent('s1'))
    expect(note.mock.lastCall![0]).toMatchObject({ preset: '', kind: 'meme', meaning: '意思', related: ['孝子'] })
    expect(mounted.tool('style_note').presentCall({ term: '梗', example: '例' }))
      .toEqual({ card: 'generic', title: 'Note 梗', kind: 'other', rawInput: '例' })
  })

  it('refuses a note without a Session, past the per-turn limit (until the turn changes), and while the service is not mounted', async () => {
    const { sink } = sinkOf()
    const mounted = mountTools(['style_note'], 1, () => sink)
    const note = (id: string) => call(mounted, 'style_note', { term: '梗', example: '例' }, agent(id))
    expect(await call(mounted, 'style_note', { term: '梗', example: '例' })).toEqual({ status: 'rejected', reason: 'no_session' })
    expect(await note('s1')).toEqual(recorded)
    expect(await note('s1')).toEqual({ status: 'rejected', reason: 'limit_reached' })
    expect(await note('s2')).toEqual(recorded)
    mounted.turn('s1', 'tool/call')
    expect(await note('s1')).toEqual({ status: 'rejected', reason: 'limit_reached' })
    mounted.turn('s1', 'turn/start')
    expect(await note('s1')).toEqual(recorded)
    mounted.turn('s1', 'turn/end')
    const gone = mountTools(['style_note'], 1, () => undefined)
    expect(await call(gone, 'style_note', { term: '梗', example: '例' }, agent('s1'))).toEqual({ status: 'rejected', reason: 'unavailable' })
  })

  it('updates the card through the service with the Session when there is one, and answers unavailable otherwise', async () => {
    const { sink, updateCard } = sinkOf()
    const mounted = mountTools(['persona_update'], 1, () => sink)
    await call(mounted, 'persona_update', { card: '卡', reason: '因' }, agent('s1'))
    expect(updateCard.mock.lastCall![0]).toEqual({ card: '卡', reason: '因', sessionId: 's1' })
    await call(mounted, 'persona_update', { card: '卡', reason: '因' })
    expect(updateCard.mock.lastCall![0]).toEqual({ card: '卡', reason: '因' })
    const gone = mountTools(['persona_update'], 1, () => undefined)
    expect(await call(gone, 'persona_update', { card: '卡', reason: '因' })).toEqual({ status: 'rejected', reason: 'unavailable' })
    expect(mounted.tool('persona_update').presentCall({ card: '卡', reason: '因' }))
      .toEqual({ card: 'generic', title: 'Update persona card', kind: 'edit', rawInput: '因' })
  })
})
