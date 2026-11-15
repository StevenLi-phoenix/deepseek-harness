/**
 * The browser entry's registration: one main page, one sidebar row that selects
 * it, and the eight dictionaries. The page is reached by clicking that row, so
 * the app's address never changes.
 */

import { describe, expect, it } from 'vitest'
import { PANEL_ID, apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

interface Registration {
  readonly options: { name: string; id?: string; key?: string; order?: number; label?: () => string; locale: string }
  readonly component: unknown
}

function fakeContext() {
  const registered: Registration[] = []
  const dictionaries: Record<string, unknown> = {}
  const ctx = {
    effect: (run: () => unknown) => run(),
    locale: {
      register: (namespace: string, value: unknown) => { dictionaries[namespace] = value; return () => {} },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Registration['options'], component: unknown) => { registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, registered, dictionaries }
}

describe('headless browser browser entry', () => {
  it('needs the slot registry and the locale', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers 浏览器接管 as a main page and a sidebar row that selects it', () => {
    const { ctx, registered } = fakeContext()
    apply(ctx as never)
    const page = registered.find(entry => entry.options.name === 'main')!
    const row = registered.find(entry => entry.options.name === 'sidebar.panellist')!
    expect(page.options).toMatchObject({ key: 'browser-takeover', locale: 'headless-browser' })
    expect(row.options).toMatchObject({ id: 'browser-takeover', order: 30, locale: 'headless-browser' })
    expect(row.options.id).toBe(page.options.key)
    expect(row.options.label?.()).toBe('nav.page')
    expect(PANEL_ID).toBe('browser-takeover')
    expect(registered.map(entry => entry.options.name).sort()).toEqual(['main', 'sidebar.panellist'])
  })

  it('registers all eight dictionaries, with the Chinese one as the key source', () => {
    const { ctx, dictionaries } = fakeContext()
    apply(ctx as never)
    const ns = dictionaries['headless-browser'] as Record<string, unknown>
    expect(Object.keys(ns).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    expect(ns['zh']).toBe(zh)
    for (const locale of Object.keys(ns)) {
      if (locale === 'zh') continue
      expect(Object.keys(ns[locale] as object).sort()).toEqual(Object.keys(zh).sort())
    }
  })
})
