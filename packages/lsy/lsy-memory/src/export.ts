/**
 * Parser for claude.ai's memory export: `## <n>. <Category>` headings over
 * `[YYYY-MM-DD] - <text>` lines. Prose around the list is ignored; an entry
 * under a heading this store has no category for fails the whole parse, so an
 * import never drops part of an export silently.
 */

import { normalizeText, type MemoryCategory, type MemoryDraft } from './entries.ts'

const HEADING = /^##\s+(?:\d+\.\s*)?(.+?)\s*$/u
const ENTRY = /^\[(\d{4}-\d{2}-\d{2})\]\s+-\s+(.+)$/u

const SECTION_CATEGORY: Readonly<Record<string, MemoryCategory>> = {
  instructions: 'instructions',
  identity: 'identity',
  career: 'career',
  projects: 'projects',
  preferences: 'preferences',
}

/**
 * Parse an export into drafts, in file order.
 * @param text - the export, Markdown with or without a surrounding code fence.
 * @throws when an entry line has no known heading above it.
 */
export function parseClaudeExport(text: string): MemoryDraft[] {
  const drafts: MemoryDraft[] = []
  let category: MemoryCategory | undefined
  let heading: string | undefined
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const section = HEADING.exec(line)
    if (section !== null) {
      heading = section[1] ?? ''
      category = SECTION_CATEGORY[heading.toLowerCase()]
      continue
    }
    const entry = ENTRY.exec(line)
    if (entry === null) continue
    if (category === undefined) {
      throw new Error(`line ${String(index + 1)}: entry under ${heading === undefined ? 'no heading' : `unknown heading "${heading}"`}`)
    }
    drafts.push({ category, date: entry[1] ?? '', text: normalizeText(entry[2] ?? '') })
  }
  return drafts
}
