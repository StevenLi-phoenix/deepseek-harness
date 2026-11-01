/**
 * WeChat and quiet-hours settings pages, browser half: two `settings.section` entries, "WeChat" (微信, order 52)
 * over the Host route `api/lsy.wechat` and "Quiet hours" (勿扰, order 53) over `api/lsy.presence`. They register
 * like the upstream pages, so they follow the settings shell's lifetime and appear after the built-in sections.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerPresence } from './presence/index.ts'
import { registerWechat } from './wechat/index.ts'

export type { WechatInjected, WechatProps, WechatKey } from './wechat/index.ts'
export type { PresenceInjected, PresenceProps, PresenceKey } from './presence/index.ts'

/** Required services: the slot registry and locale. */
export const inject = ['slots', 'locale']

/**
 * Register both sections.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  registerWechat(ctx)
  registerPresence(ctx)
}
