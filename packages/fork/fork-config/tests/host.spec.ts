import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import type {} from '@deepseek-ai/dsh-settings'
import { configFixture } from './fixture.ts'
import { leavesOf, type ConfigEntryView, type LeafField } from '../src/view.ts'

const entryOf = async (get: () => Promise<{ entries: readonly ConfigEntryView[] }>, id = 'sample'): Promise<ConfigEntryView> =>
  (await get()).entries.find(entry => entry.id === id)!
const leaf = (entry: ConfigEntryView, path: string): LeafField => leavesOf(entry.fields).find(item => item.path.join('.') === path)!
const ownerPatch = (profile: { patchPath: string }): unknown => parse(readFileSync(profile.patchPath, 'utf8'))

describe('fork-config Host route', () => {
  it('registers one route for the read and the save, under the /api sign-in', async () => {
    const { routes } = await configFixture()
    expect(routes.map(route => [route.path, route.methods, route.requestBody])).toEqual([['/api/fork.config', ['GET', 'POST'], 'buffered']])
  })

  it('describes every field of the schema, grouped as the schema nests them', async () => {
    const { get } = await configFixture()
    const entry = await entryOf(() => get())
    expect(entry).toMatchObject({ found: true, active: true, locked: false, overrides: 0 })
    expect(entry.fields.map(node => [node.kind, node.key])).toEqual([
      ['string', 'url'], ['credential-ref', 'tokenEnv'], ['secret', 'password'], ['string-list', 'groups'],
      ['group', 'media'], ['select', 'mode'], ['json', 'extra'], ['string', 'note'],
    ])
    expect(leavesOf(entry.fields).map(item => item.path.join('.'))).toEqual([
      'url', 'tokenEnv', 'password', 'groups', 'media.images', 'media.maxBytes', 'media.hosts', 'mode', 'extra', 'note',
    ])
    expect(leaf(entry, 'media.maxBytes')).toMatchObject({ kind: 'number', min: 1024, step: 1, default: 15 * 1024 * 1024, value: 4096 })
    expect(leaf(entry, 'mode')).toMatchObject({ options: ['fast', 'slow'], default: 'fast' })
    expect(leaf(entry, 'note')).toMatchObject({ description: 'Shown in the card' })
  })

  it('names the layer of each field: default, bundle, owner patch', async () => {
    const { get, post } = await configFixture()
    const before = leavesOf((await entryOf(() => get())).fields)
    expect(Object.fromEntries(before.map(item => [item.path.join('.'), item.layer]))).toMatchObject({
      url: 'bundle', tokenEnv: 'default', 'media.maxBytes': 'bundle', 'media.images': 'default', note: 'default',
    })
    const entry = await entryOf(() => get())
    await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['url'], value: 'ws://owner:2' }] })
    const after = await entryOf(() => get())
    expect(leaf(after, 'url')).toMatchObject({ layer: 'owner', value: 'ws://owner:2' })
    expect(leaf(after, 'media.maxBytes').layer).toBe('bundle')
    expect(after.overrides).toBe(1)
  })

  it('marks every field of an entry the home patch sets as home and read-only', async () => {
    const { get, post } = await configFixture({ home: [{ id: 'sample', config: { url: 'ws://home:3', password: 'p', media: {} } }] })
    const entry = await entryOf(() => get())
    expect(entry.locked).toBe(true)
    expect(leavesOf(entry.fields).map(item => [item.layer, item.readOnly])).toEqual(Array(10).fill(['home', expect.anything()]))
    expect(leaf(entry, 'url')).toMatchObject({ layer: 'home', readOnly: 'home', value: 'ws://home:3' })
    const refused = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['url'], value: 'ws://x:1' }] })
    expect(refused).toMatchObject({ status: 409, body: { ok: false, reason: 'home-locked' } })
  })

  it('never carries a credential value: only whether the slot holds one', async () => {
    const { get } = await configFixture()
    const text = JSON.stringify(await get('sample,other'))
    expect(text).not.toContain('private-value')
    expect(leaf(await entryOf(() => get()), 'password')).toEqual({
      key: 'password', path: ['password'], kind: 'secret', layer: 'default', required: false, set: true, readOnly: 'secret',
    })
  })

  it('tells a running plugin without a Config, a disabled entry, and an unknown id apart', async () => {
    const { get } = await configFixture()
    const { entries } = await get('bare,off,nope')
    expect(entries.map(entry => [entry.id, entry.found, entry.active, entry.fields.length])).toEqual([
      ['bare', true, true, 0], ['off', true, false, 0], ['nope', false, false, 0],
    ])
  })

  it('reports an entry that is not in the composition as not found', async () => {
    const { get } = await configFixture()
    expect((await get('nope')).entries[0]).toMatchObject({ id: 'nope', found: false, fields: [] })
  })

  it('writes only the owner patch, restating the whole config with the one changed field', async () => {
    const { get, post, profile, logs } = await configFixture()
    const entry = await entryOf(() => get())
    const result = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['media', 'maxBytes'], value: 8192 }] })
    expect(result).toMatchObject({ status: 200, body: { ok: true, changed: ['media.maxBytes'] } })
    // The revision the save answers with is the one the next read reports, which is what the browser waits for after the reload.
    expect(result.body).toMatchObject({ revision: (await entryOf(() => get())).revision })
    expect(ownerPatch(profile)).toEqual([{
      id: 'sample', name: 'cordis:probe',
      config: { url: 'ws://bundle:1', password: 'private-value', media: { maxBytes: 8192 } },
    }])
    // The bundle's own file is untouched.
    const bundleRows = JSON.parse(readFileSync(join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; config: { media: unknown } }> }>
    expect(bundleRows[0]?.insert.find(row => row.id === 'sample')?.config.media).toEqual({ maxBytes: 4096 })
    expect(logs.filter(line => line.startsWith('info fork-config: saved')).map(line => line.replace(/\d+ms$/, 'Nms')))
      .toEqual(['info fork-config: saved sample changed=[media.maxBytes] reload=true outcome=ok in Nms'])
  })

  it('applies many edits in one write and reloads the plugin once', async () => {
    const { get, post, applied } = await configFixture()
    const entry = await entryOf(() => get())
    const before = applied.length
    const result = await post({
      id: 'sample', revision: entry.revision,
      ops: [
        { op: 'set', path: ['url'], value: 'ws://owner:9' },
        { op: 'set', path: ['mode'], value: 'slow' },
        { op: 'set', path: ['media', 'hosts'], value: ['a.example', 'b.example'] },
      ],
    })
    expect(result.body).toMatchObject({ ok: true, changed: ['url', 'mode', 'media.hosts'] })
    expect(applied.length - before).toBe(1)
    expect(applied.at(-1)).toMatchObject({ url: 'ws://owner:9', mode: 'slow', media: { hosts: ['a.example', 'b.example'] } })
  })

  it('resets a field to the bundle value, then drops the override row when nothing differs', async () => {
    const { get, post, profile } = await configFixture()
    let entry = await entryOf(() => get())
    await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['url'], value: 'ws://owner:2' }, { op: 'set', path: ['mode'], value: 'slow' }] })
    entry = await entryOf(() => get())
    expect(entry.overrides).toBe(2)
    const reset = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'unset', path: ['url'] }] })
    expect(reset.body).toMatchObject({ ok: true, changed: ['url'] })
    entry = await entryOf(() => get())
    expect(leaf(entry, 'url')).toMatchObject({ layer: 'bundle', value: 'ws://bundle:1' })
    expect(leaf(entry, 'mode').layer).toBe('owner')
    await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'unset', path: ['mode'] }] })
    expect(ownerPatch(profile)).toEqual([])
    expect((await entryOf(() => get())).overrides).toBe(0)
  })

  it('clears a field the bundle sets, so the schema default applies, and shows what a reset would return to', async () => {
    const { get, post } = await configFixture()
    let entry = await entryOf(() => get())
    expect(leaf(entry, 'url')).not.toHaveProperty('base')
    const cleared = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'clear', path: ['url'] }] })
    expect(cleared.body).toMatchObject({ ok: true, changed: ['url'] })
    entry = await entryOf(() => get())
    expect(leaf(entry, 'url')).toMatchObject({ layer: 'owner', default: 'ws://127.0.0.1:3001', base: 'ws://bundle:1' })
    expect(leaf(entry, 'url')).not.toHaveProperty('value')
  })

  it('prunes a group the reset empties where the bundle sets nothing', async () => {
    const { get, post, profile } = await configFixture({ bundle: { password: 'p' } })
    let entry = await entryOf(() => get())
    await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['media', 'images'], value: false }] })
    entry = await entryOf(() => get())
    await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'unset', path: ['media', 'images'] }] })
    expect(ownerPatch(profile)).toEqual([])
  })

  it('writes nothing and reloads nothing for a save that changes no field', async () => {
    const { get, post, applied, profile } = await configFixture()
    const entry = await entryOf(() => get())
    const before = applied.length
    const result = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['url'], value: 'ws://bundle:1' }, { op: 'unset', path: ['note'] }] })
    expect(result.body).toMatchObject({ ok: true, changed: [] })
    expect(applied.length).toBe(before)
    expect(ownerPatch(profile)).toEqual([])
  })

  it('refuses a stale revision without writing', async () => {
    const { get, post, profile } = await configFixture()
    const stale = (await entryOf(() => get())).revision
    await post({ id: 'sample', revision: stale, ops: [{ op: 'set', path: ['url'], value: 'ws://a:1' }] })
    const before = readFileSync(profile.patchPath, 'utf8')
    const second = await post({ id: 'sample', revision: stale, ops: [{ op: 'set', path: ['url'], value: 'ws://b:2' }] })
    expect(second).toMatchObject({ status: 409, body: { ok: false, reason: 'conflict' } })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  })

  it('refuses credential fields, unknown paths, groups, and invalid values without writing', async () => {
    const { get, post, profile, logs } = await configFixture()
    const { revision } = await entryOf(() => get())
    const before = readFileSync(profile.patchPath, 'utf8')
    const refuse = (ops: unknown[]) => post({ id: 'sample', revision, ops })
    expect(await refuse([{ op: 'set', path: ['password'], value: 'new-secret' }])).toMatchObject({ status: 400, body: { reason: 'bad-request' } })
    expect(await refuse([{ op: 'unset', path: ['password'] }])).toMatchObject({ status: 400 })
    expect(await refuse([{ op: 'set', path: ['nope'], value: 1 }])).toMatchObject({ status: 400 })
    expect(await refuse([{ op: 'set', path: ['media'], value: {} }])).toMatchObject({ status: 400 })
    expect(await refuse([{ op: 'set', path: ['media', 'maxBytes'], value: 10 }])).toMatchObject({ status: 422, body: { reason: 'invalid' } })
    expect(await refuse([{ op: 'set', path: ['media', 'maxBytes'], value: 'many' }])).toMatchObject({ status: 422 })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
    expect(logs.join('\n')).not.toContain('new-secret')
    expect(logs.join('\n')).not.toContain('private-value')
  })

  it('refuses malformed requests', async () => {
    const { get, post, routes } = await configFixture()
    await get()
    expect(await post({ id: 'sample' })).toMatchObject({ status: 400 })
    expect(await post({ id: 'sample', revision: 'x', ops: [] })).toMatchObject({ status: 400 })
    expect(await post({ id: '../x', revision: 'x', ops: [{ op: 'unset', path: ['url'] }] })).toMatchObject({ status: 400 })
    expect(await post({ id: 'missing', revision: 'x', ops: [{ op: 'unset', path: ['url'] }] })).toMatchObject({ status: 404 })
    const bad = await routes[0]!.fetch(new Request('http://127.0.0.1/api/fork.config?entries='))
    expect(bad.status).toBe(400)
    const notJson = await routes[0]!.fetch(new Request('http://127.0.0.1/api/fork.config', { method: 'POST', body: '{' }))
    expect(notJson.status).toBe(400)
  })

  it('leaves an expression-valued field read-only and keeps it through another save', async () => {
    const { get, post, profile } = await configFixture({
      ownerText: '- id: sample\n  name: cordis:probe\n  config:\n    url: !!js "\'ws://expr:5\'"\n    password: private-value\n    media: {}\n',
    })
    const entry = await entryOf(() => get())
    expect(leaf(entry, 'url')).toMatchObject({ readOnly: 'expression', layer: 'owner' })
    expect(leaf(entry, 'url')).not.toHaveProperty('value')
    expect(await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['url'], value: 'ws://x:1' }] })).toMatchObject({ status: 400 })
    const saved = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['mode'], value: 'slow' }] })
    expect(saved.body).toMatchObject({ ok: true, changed: ['mode'] })
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('!!js')
  })
})

describe('beside a dedicated editor of some fields', () => {
  const card = (entry: ConfigEntryView, op: unknown, exclude: string[] = ['groups']) => ({ id: 'sample', revision: entry.revision, ops: [op], exclude })

  it('leaves the excluded fields out of the form and out of its count', async () => {
    const { get } = await configFixture({ owner: [{ id: 'sample', name: 'cordis:probe', config: { password: 'x', groups: ['1'], media: { images: false } } }] })
    const shown = await entryOf(() => get('sample', 'groups,media.images'))
    expect(leavesOf(shown.fields).map(item => item.path.join('.'))).not.toEqual(expect.arrayContaining(['groups']))
    expect(leavesOf(shown.fields).map(item => item.path.join('.'))).not.toContain('media.images')
    expect(leavesOf(shown.fields)).toHaveLength(8)
    // Only `url` and `media.maxBytes` differ from the bundle among the fields shown; `groups` and `media.images` do not count.
    expect(shown.overrides).toBe(2)
    const group = await entryOf(() => get('sample', 'media'))
    expect(group.fields.map(node => node.key)).not.toContain('media')
  })

  it('keeps the dedicated editor\'s value when it changed an excluded field after the form was read', async () => {
    const { ctx, get, post, profile } = await configFixture()
    const entry = await entryOf(() => get('sample', 'groups'))
    await ctx.settings.update('sample', { groups: ['111', '222'] })
    const saved = await post(card(entry, { op: 'set', path: ['url'], value: 'ws://card:1' }))
    expect(saved).toMatchObject({ status: 200, body: { ok: true, changed: ['url'] } })
    const [row] = ownerPatch(profile) as Array<{ config: Record<string, unknown> }>
    expect(row?.config).toMatchObject({ url: 'ws://card:1', groups: ['111', '222'] })
  })

  it('rejects the save as stale when the form showed the field the editor changed', async () => {
    const { ctx, get, post, profile } = await configFixture()
    const entry = await entryOf(() => get('sample'))
    await ctx.settings.update('sample', { groups: ['111'] })
    const before = readFileSync(profile.patchPath, 'utf8')
    const refused = await post(card(entry, { op: 'set', path: ['url'], value: 'ws://card:1' }, []))
    expect(refused).toMatchObject({ status: 409, body: { ok: false, reason: 'conflict' } })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  })

  it('makes the dedicated editor\'s stale write fail after the card saved, so both go through one fenced writer', async () => {
    const { ctx, get, post } = await configFixture()
    const staleRevision = ctx.settings.describe().find(row => row.ns === 'sample')!.revision
    const entry = await entryOf(() => get('sample', 'groups'))
    await post(card(entry, { op: 'set', path: ['url'], value: 'ws://card:1' }))
    await expect(ctx.settings.update('sample', { groups: ['9'] }, staleRevision)).rejects.toThrow('changed since it was read')
  })

  it('refuses an edit of an excluded field or of a field below an excluded group', async () => {
    const { get, post, profile } = await configFixture()
    const entry = await entryOf(() => get('sample', 'groups,media'))
    const before = readFileSync(profile.patchPath, 'utf8')
    for (const path of [['groups'], ['media', 'images']]) {
      expect(await post(card(entry, { op: 'set', path, value: path[0] === 'groups' ? ['1'] : false }, ['groups', 'media'])))
        .toMatchObject({ status: 400, body: { reason: 'bad-request' } })
    }
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  })

  it('refuses malformed exclude lists', async () => {
    const { routes } = await configFixture()
    const bad = await routes[0]!.fetch(new Request('http://127.0.0.1/api/fork.config?entries=sample&exclude=a%20b'))
    expect(bad.status).toBe(400)
  })
})

describe('volatile fields', () => {
  it('flags them in the form', async () => {
    const { get } = await configFixture()
    const entry = await entryOf(() => get())
    expect(leaf(entry, 'groups')).toMatchObject({ volatile: true })
    expect(leaf(entry, 'url')).not.toHaveProperty('volatile')
  })

  it('applies a volatile-only save to the running plugin without reloading it, as the upstream settings path does', async () => {
    const { get, post, applied, profile } = await configFixture()
    const entry = await entryOf(() => get())
    const before = applied.length
    const result = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['groups'], value: ['1', '2'] }] })
    expect(result.body).toMatchObject({ ok: true, changed: ['groups'], reload: false })
    expect(applied.length).toBe(before)
    const [row] = ownerPatch(profile) as Array<{ config: { groups: string[] } }>
    expect(row?.config.groups).toEqual(['1', '2'])
  })

  it('reloads the plugin once when any changed field is not volatile, and says so', async () => {
    const { get, post, applied, logs } = await configFixture()
    const entry = await entryOf(() => get())
    const before = applied.length
    const result = await post({ id: 'sample', revision: entry.revision, ops: [{ op: 'set', path: ['groups'], value: ['1'] }, { op: 'set', path: ['url'], value: 'ws://x:1' }] })
    expect(result.body).toMatchObject({ ok: true, reload: true })
    expect(applied.length - before).toBe(1)
    expect(logs.some(line => line.includes('changed=[groups,url] reload=true'))).toBe(true)
  })
})
