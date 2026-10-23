/**
 * The memory context block: instructions and preferences in full, the other
 * categories as one line of opening words per entry, inside a byte budget.
 */

import { CATEGORIES, FULL_TEXT_CATEGORIES, type MemoryCategory, type MemoryEntry } from './entries.ts'

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

/** Characters of an indexed entry shown in the block. */
export const INDEX_CHARS = 80

const HEADINGS: Readonly<Record<MemoryCategory, string>> = {
  instructions: 'Instructions',
  preferences: 'Preferences',
  identity: 'Identity',
  career: 'Career',
  projects: 'Projects',
}

const INTRO = [
  'Your memory of the owner, kept across sessions. Follow the instructions and preferences below unless the owner says otherwise in this conversation.',
  'Identity, career, and project entries show only their opening words: call memory_search for the full entry before relying on one, and whenever the owner\'s background, people, courses, work, or projects may matter. Entries mix Chinese and English, so search in both when unsure.',
  'When the owner asks you to remember something, corrects a remembered fact, or asks you to forget one, call memory_save or memory_forget in the same turn. Each entry is one fact; the host dates it.',
].join('\n')

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function opening(text: string): string {
  const parts = Array.from(graphemes.segment(text), part => part.segment)
  return parts.length <= INDEX_CHARS ? text : `${parts.slice(0, INDEX_CHARS).join('')}…`
}

function line(entry: MemoryEntry): string {
  return FULL_TEXT_CATEGORIES.has(entry.category)
    ? `- [${entry.date}] (${entry.id}) ${entry.text}`
    : `- ${entry.id} · ${opening(entry.text)}`
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/**
 * Render the block.
 * @param entries - every entry, in file order.
 * @param maxBytes - cap on the whole block; entries that do not fit are counted in a closing note.
 * @returns the block, or undefined when there are no entries.
 */
export function renderMemoryBlock(entries: readonly MemoryEntry[], maxBytes: number): string | undefined {
  if (entries.length === 0) return undefined
  const lines = [OPEN, INTRO]
  // Room for the closing note and frame, so whatever is left out is still announced.
  const reserve = bytes(`\n\n(999 more entries did not fit; memory_search finds them.)\n${CLOSE}`)
  let used = bytes(lines.join('\n'))
  let omitted = 0
  for (const category of CATEGORIES) {
    const members = entries.filter(entry => entry.category === category)
    if (members.length === 0) continue
    const suffix = FULL_TEXT_CATEGORIES.has(category) ? '' : ' (opening words; memory_search for details)'
    const heading = `\n## ${HEADINGS[category]}${suffix}`
    let headed = false
    for (const entry of members) {
      const rendered = (headed ? '' : `${heading}\n`) + line(entry).replaceAll(CLOSE, '<\\/system-reminder>')
      const cost = bytes(rendered) + 1
      if (omitted > 0 || used + cost + reserve > maxBytes) {
        omitted += 1
        continue
      }
      lines.push(rendered)
      used += cost
      headed = true
    }
  }
  if (omitted > 0) lines.push(`\n(${String(omitted)} more entries did not fit; memory_search finds them.)`)
  lines.push(CLOSE)
  return lines.join('\n')
}
