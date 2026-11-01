/**
 * Course deadlines, browser half: a Settings section ("课程 DDL") over this package's Host routes
 * (`api/fork.courses`, `api/fork.courses.poll`). The section registers into `settings.section` like the upstream
 * pages, so it follows the settings shell's lifetime and appears after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { COURSES_POLL_ROUTE, COURSES_ROUTE } from '../view.ts'
import { CoursesLoader, createCoursesStore, parseView } from './courses.ts'
import { CoursesSection, type CoursesInjected } from './CoursesSection.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'

export type { CoursesInjected, CoursesProps } from './CoursesSection.tsx'
export type { CoursesKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fork.courses'

/** Settings navigation position: after QQ (45) and before 勿扰 (53). */
const SECTION_ORDER = 47

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register the dictionaries and the Settings section over one shared store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'fork-courses-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createCoursesStore()
  const answer = async (response: Response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseView(await response.json())
  }
  const loader = new CoursesLoader(
    store,
    // Document-relative, so a served mount keeps working; the sign-in cookie rides along.
    async () => answer(await fetch(COURSES_ROUTE, { credentials: 'same-origin', cache: 'no-store' })),
    async () => answer(await fetch(COURSES_POLL_ROUTE, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' })),
  )
  // One function each for the registration's lifetime, so the section's polling effect never restarts on re-render.
  const refresh = (): void => { void loader.refresh() }
  const checkNow = (): void => { void loader.checkNow() }
  const injected = (): CoursesInjected => ({ hooks: { courses: store }, refresh, checkNow })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'fork-courses', order: SECTION_ORDER, label: () => t('nav'), locale: NS, inject: injected,
  }, CoursesSection))
}
