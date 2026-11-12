/**
 * Gmail tools for the owner's main agent, over `ctx.forkGmail`: the accounts, a search, a read, an attachment, a
 * draft, a send, and label changes. Received mail is wrapped as untrusted data, and the read tools count as
 * strangers' words for `fork-taint`, so a send after reading mail waits for the owner. The send gate itself lives in
 * `fork-gmail`, which decides with the turn's facts this package reads from the Session log.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ForkGmail } from '@deepseek-ai/dsh-fork-gmail'
import z from '@deepseek-ai/schemastery'
import { gmailTools, registerTool } from './tools.ts'

export { accountLines, dataBlock, messageLines, searchLines, size, TAG, threadLines, TRUST_NOTE, when } from './format.ts'
export { gmailTools, list, registerTool, text, ToolProblem, type ToolDeps } from './tools.ts'
export { turnFacts } from './turn.ts'

/** Plugin name. */
export const name = 'fork-tool-gmail'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** IANA zone dates are shown in. */
  timeZone: string
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  timeZone: z.string().default('America/New_York').description('IANA zone dates are shown in.'),
})

/**
 * Register the Gmail tools once `ctx.forkGmail` is mounted.
 * @param ctx - the preset scope's context.
 * @param config - the time zone.
 */
export function apply(ctx: Context, config: Config): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    // RangeError: an unknown zone is a configuration error, reported at load.
    throw new Error(`fork-tool-gmail: timeZone "${config.timeZone}" is not a valid IANA time zone`)
  }
  ctx.inject(['forkGmail'], (scoped) => {
    const gmail: ForkGmail = scoped.forkGmail
    for (const spec of gmailTools({ ctx: scoped, gmail, timeZone: config.timeZone })) registerTool(scoped, spec)
  })
}
