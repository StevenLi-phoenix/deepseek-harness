import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { TabStore } from '../src/tab-store.ts'

const first = '2026-01-01T00:00:00.000Z'
const next = '2026-01-01T00:00:01.000Z'
const tab = {
  id: 't-one', openedAt: first, lastNavigatedAt: first, openedBySessionId: 'session-a',
  url: 'https://account:password@example.test/application?field=unsaved#access_token=session-secret', title: 'Application',
}

it('persists only owner-readable tab metadata and reconciles open rows against tab identity, not URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tab-store-'))
  const path = join(root, 'tabs.json')
  const log = new Context().logger
  try {
    const store = new TabStore(path, log)
    expect(await store.hasOpenTabs()).toBe(false)
    store.see(tab)
    store.see({ ...tab, id: 't-two', url: 'data:text/html,<input value="page-secret">', title: 'Other' })
    store.see({ ...tab, id: 't-three' })
    store.closed('t-three', next)
    await store.flush()
    const contents = await readFile(path, 'utf8')
    for (const secret of ['account:', 'password', 'unsaved', 'session-secret', 'page-secret']) {
      expect(contents).not.toContain(secret)
    }
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(contents)).toEqual({ version: 1, tabs: [
      { id: 't-one', url: 'https://example.test/application', title: 'Application', firstSeenAt: first, lastSeenAt: first, openedBySessionId: 'session-a', status: 'open' },
      { id: 't-two', url: 'data:', title: 'Other', firstSeenAt: first, lastSeenAt: first, openedBySessionId: 'session-a', status: 'open' },
      { id: 't-three', url: 'https://example.test/application', title: 'Application', firstSeenAt: first, lastSeenAt: next, openedBySessionId: 'session-a', status: 'closed' },
    ] })

    const restarted = new TabStore(path, log)
    expect(await restarted.hasOpenTabs()).toBe(true)
    restarted.see({ ...tab, id: 't-four', openedAt: next, lastNavigatedAt: next, openedBySessionId: null })
    await restarted.reconcile(['t-four'])
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ tabs: [
      { id: 't-one', status: 'lost', lastSeenAt: first },
      { id: 't-two', status: 'lost' },
      { id: 't-three', status: 'closed' },
      { id: 't-four', status: 'open', openedBySessionId: null },
    ] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tab-store-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'tabs.json')
  const log = new Context().logger
  const warnings: unknown[][] = []
  log.exporter({ export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
  return { root, path, store: new TabStore(path, log), warnings }
}

const openRow = {
  id: tab.id, url: 'https://example.test/application', title: tab.title, firstSeenAt: first, lastSeenAt: first,
  openedBySessionId: tab.openedBySessionId, status: 'open',
}

it('does not rewrite the ledger for duplicate observations, unknown closes, or an unchanged reconciliation', async () => {
  const { path, store } = await fixture()
  store.see(tab)
  await store.flush()
  const unchangedSince = new Date(first)
  await utimes(path, unchangedSince, unchangedSince)

  store.see({ ...tab, url: 'https://example.test/application?new-query#new-fragment' })
  store.closed('absent', next)
  await store.reconcile([tab.id])

  expect((await stat(path)).mtimeMs).toBe(unchangedSince.getTime())
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [openRow] })
})

it('updates the row when any tracked navigation field changes and ignores repeated closes', async () => {
  const { path, store } = await fixture()
  const navigated = { ...tab, url: 'http://example.test/next' }
  const retitled = { ...navigated, title: 'Next' }
  const revisited = { ...retitled, lastNavigatedAt: next }
  const reassigned = { ...revisited, openedBySessionId: null }
  const expected = [
    [tab, openRow],
    [navigated, { ...openRow, url: navigated.url }],
    [retitled, { ...openRow, url: navigated.url, title: retitled.title }],
    [revisited, { ...openRow, url: navigated.url, title: retitled.title, lastSeenAt: next }],
    [reassigned, { ...openRow, url: navigated.url, title: retitled.title, lastSeenAt: next, openedBySessionId: null }],
  ] as const
  for (const [observation, row] of expected) {
    store.see(observation)
    await store.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [row] })
  }

  store.closed(tab.id, next)
  store.closed(tab.id, '2026-01-01T00:00:02.000Z')
  await store.flush()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [{ ...expected[4][1], status: 'closed' }] })
})

it.each([
  ['invalid JSON', 'not JSON: do not log this ledger text'],
  ['null root', 'null'],
  ['primitive root', '7'],
  ['array root', '[]'],
  ['unsupported version', '{"version":2,"tabs":[]}'],
  ['non-array tabs', '{"version":1,"tabs":{}}'],
])('starts with an empty ledger and logs no file contents for %s', async (_description, contents) => {
  const { path, store, warnings } = await fixture()
  await writeFile(path, contents)

  expect(await store.hasOpenTabs()).toBe(false)
  expect(warnings).toEqual([['headless-browser: could not read tabs.json']])

  store.see(tab)
  await store.flush()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [openRow] })
})

it('skips malformed rows and normalizes valid rows read from disk', async () => {
  const { path, store, warnings } = await fixture()
  await writeFile(path, JSON.stringify({ version: 1, tabs: [
    null, 1, [],
    { ...openRow, id: 1 },
    { ...openRow, id: 'bad-url', url: 1 },
    { ...openRow, id: 'bad-title', title: 1 },
    { ...openRow, id: 'bad-first-seen', firstSeenAt: 1 },
    { ...openRow, id: 'bad-last-seen', lastSeenAt: 1 },
    { ...openRow, id: 'bad-session', openedBySessionId: 1 },
    { ...openRow, id: 'bad-status', status: 'missing' },
    { ...openRow, url: tab.url, title: 'a'.repeat(257) },
    { ...openRow, id: 'lost', url: 'not a URL', status: 'lost', openedBySessionId: null },
  ] }))

  expect(await store.hasOpenTabs()).toBe(true)
  store.see({ ...tab, id: 'blank', url: 'about:blank' })
  await store.flush()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [
    { ...openRow, title: 'a'.repeat(256) },
    { ...openRow, id: 'lost', url: '', status: 'lost', openedBySessionId: null },
    { ...openRow, id: 'blank', url: 'about:blank' },
  ] })
  expect(warnings).toEqual([])
})

it('keeps open rows and only the 64 most recent closed or lost rows', async () => {
  const { path, store } = await fixture()
  const history = Array.from({ length: 66 }, (_, i) => ({
    ...openRow, id: `old-${i}`, status: i % 2 === 0 ? 'closed' : 'lost',
    lastSeenAt: new Date(Date.parse(next) + i * 1000).toISOString(),
  })).reverse()
  await writeFile(path, JSON.stringify({ version: 1, tabs: [...history, openRow] }))

  store.see({ ...tab, id: 'new' })
  await store.flush()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [
    ...history.slice(0, 64), openRow, { ...openRow, id: 'new' },
  ] })
})

it('cleans up a failed atomic replacement and allows subsequent updates to persist', async () => {
  const { root, path, store, warnings } = await fixture()
  expect(await store.hasOpenTabs()).toBe(false)
  await mkdir(path)

  store.see(tab)
  await store.flush()
  expect(await readdir(root)).toEqual(['tabs.json'])
  expect(warnings).toEqual([['headless-browser: could not save tabs.json: %s', expect.stringMatching(/rename/)]])

  await rmdir(path)
  store.see({ ...tab, id: 'second' })
  await store.flush()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, tabs: [openRow, { ...openRow, id: 'second' }] })
  expect(warnings).toHaveLength(1)
})
