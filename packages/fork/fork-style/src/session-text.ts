/**
 * What a Session just read, from its own log. The log is written by the host, never by the model, so an example that
 * appears in it is verbatim. Only results of tools that return public text count (web pages and searches, QQ groups,
 * the Bilibili reads): not memory, shell, or file results, and not the owner's own messages, which are private text
 * and must not become an example in a block other channels read. The same Session-log read fork-taint uses for the
 * turn's origin.
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Tools whose results carry public text: the set fork-taint treats as carrying strangers' words, plus the Bilibili reads. */
const PUBLIC_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch', 'qq_groups', 'qq_digest', 'qq_recent', 'qq_search'])
const PUBLIC_PREFIX = /^(?:bili_|up_)/u

/** Events read back at most, and turns (the open one and the one before it). */
const MAX_EVENTS = 400
const MAX_TURNS = 2
/** Characters of text returned at most. */
const MAX_CHARS = 400_000

/**
 * Whether a tool's result counts as public text.
 * @param name - the tool name.
 * @returns true for the web, QQ, and Bilibili read tools.
 */
export const isPublicTextTool = (name: string): boolean => PUBLIC_TOOLS.has(name) || PUBLIC_PREFIX.test(name)

/** The part of a Session this module reads. */
export type SessionLog = Pick<Session, 'seq' | 'eventAt'>

/** String leaves of a JSON value, so a quote inside an escaped tool result still matches. */
function leaves(value: unknown, out: string[], depth = 0): void {
  if (typeof value === 'string') out.push(value)
  else if (depth < 6 && Array.isArray(value)) for (const item of value) leaves(item, out, depth + 1)
  else if (depth < 6 && typeof value === 'object' && value !== null) for (const item of Object.values(value)) leaves(item, out, depth + 1)
}

/** The tools whose results the main agent's web reading consists of. */
export const WEB_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch'])

/**
 * The text of the public-text tool results in the Session's open turn and the turn before it.
 * @param session - the Session whose tool is running.
 * @param options - `tools`: only these tools' results; `leaves: false`: whole results only, without the string values of a JSON result.
 * @returns each result's text, and for a JSON result its string values as well; empty when there are none.
 */
export function recentPublicText(
  session: SessionLog,
  options: { readonly tools?: ReadonlySet<string>; readonly leaves?: boolean } = {},
): string[] {
  const events: SessionEvent[] = []
  let turns = 0
  for (let seq = session.seq - 1; seq >= 0 && events.length < MAX_EVENTS; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Same Session history read as fork-taint's turn origin.
    const event = session.eventAt(seq as never)
    if (event === undefined) continue
    events.push(event)
    if (event.type === 'turn/start' && (turns += 1) >= MAX_TURNS) break
  }
  events.reverse()
  const names = new Map<string, string>()
  const out: string[] = []
  let chars = 0
  for (const event of events) {
    if (event.type === 'tool/call') {
      names.set(String(event.data.callId), event.data.name)
    } else if (event.type === 'tool/result') {
      const name = names.get(String(event.data.message.toolCallId))
      if (name === undefined || !(options.tools?.has(name) ?? isPublicTextTool(name))) continue
      const content: unknown = event.data.message.content
      const text = Array.isArray(content)
        ? (content as Array<{ type?: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
        : ''
      if (text === '' || chars + text.length > MAX_CHARS) continue
      chars += text.length
      out.push(text)
      if (options.leaves === false) continue
      try {
        const parsed: unknown = JSON.parse(text)
        leaves(parsed, out)
      } catch {
        // Not JSON: the text itself was added.
      }
    }
  }
  return out
}
