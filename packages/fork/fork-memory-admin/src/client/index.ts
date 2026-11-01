/**
 * Memory settings plugin, browser half: a Settings section ("Memory", 记忆) over this package's Host route
 * (`api/fork.memory`). The section registers into `settings.section` like the upstream pages, so it follows
 * the settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { GUARD_ROUTE, MEMORY_ROUTE, type ActionResult, type DetailView, type MemoryAction, type MemoryQuery } from '../view.ts'
import { MemoryLoader, MemoryRequestError, createMemoryStore, parseGuard, parseView, type MemoryActions, type MemoryApi } from './memory.ts'
import { MemorySection, type MemoryInjected } from './MemorySettings.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { MemoryInjected, MemoryProps } from './MemorySettings.tsx'
export type { MemoryKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fork.memory'

/** Settings navigation position: after System status (40) and the Bilibili account (45). */
const SECTION_ORDER = 55

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/** One request to the route; the sign-in cookie rides along. */
async function request(query: string, init?: RequestInit): Promise<unknown> {
  // Document-relative, so a served mount keeps working.
  const response = await fetch(`${MEMORY_ROUTE}${query}`, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const fields = body as { error?: unknown; code?: unknown }
    throw new MemoryRequestError(
      typeof fields.error === 'string' ? fields.error : `HTTP ${String(response.status)}`,
      typeof fields.code === 'string' ? fields.code : null,
    )
  }
  return body
}

/** The Host calls the loader makes. */
const api: MemoryApi = {
  async read(query: MemoryQuery) {
    const params = new URLSearchParams({ category: query.category, offset: String(query.offset), limit: String(query.limit) })
    if (query.q !== '') params.set('q', query.q)
    return parseView(await request(`?${params.toString()}`))
  },
  async guard() {
    const response = await fetch(GUARD_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
    return response.ok ? parseGuard(await response.json().catch(() => null)) : null
  },
  async detail(id: string) {
    return await request(`?id=${encodeURIComponent(id)}`) as DetailView
  },
  async post(action: MemoryAction) {
    return await request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }) as ActionResult
  },
}

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'fork-memory-admin: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createMemoryStore()
  const loader = new MemoryLoader(store, api)
  // Bound once, so the section's polling effect never restarts on re-render.
  const actions: MemoryActions = {
    refresh: () => loader.refresh(),
    setQuery: patch => loader.setQuery(patch),
    review: (op, ids) => loader.review(op, ids),
    loadDetail: id => loader.loadDetail(id),
    rollbackPreview: target => loader.rollbackPreview(target),
    rollbackApply: () => loader.rollbackApply(),
    rollbackCancel: () => { loader.rollbackCancel() },
    purgePreview: ids => loader.purgePreview(ids),
    purgeApply: () => loader.purgeApply(),
    purgeCancel: () => { loader.purgeCancel() },
    feedbackAdd: input => loader.feedbackAdd(input),
    feedbackForget: id => loader.feedbackForget(id),
    dismissError: () => { loader.dismissError() },
  }
  const injected = (): MemoryInjected => ({ hooks: { memory: store }, actions })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-memory', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, MemorySection))
}
