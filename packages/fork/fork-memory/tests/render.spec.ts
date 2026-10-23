import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '../src/entries.ts'
import { renderMemoryBlock } from '../src/render.ts'

const entry = (id: string, category: MemoryEntry['category'], text: string): MemoryEntry => ({ id, category, date: '2026-10-20', text })

describe('renderMemoryBlock', () => {
  it('renders nothing without entries', () => {
    expect(renderMemoryBlock([], 65_536)).toBeUndefined()
  })

  it('carries instructions and preferences in full, career and projects by opening words, identity as a count', () => {
    const long = `${'长'.repeat(85)}尾巴`
    const text = renderMemoryBlock([
      entry('aaaaaa', 'projects', 'INKFISH P0 — simulation'),
      entry('bbbbbb', 'instructions', 'Search before claiming'),
      entry('cccccc', 'career', long),
      entry('dddddd', 'preferences', 'Dense Markdown'),
      entry('eeeeee', 'identity', 'Father 某某 (someone@example.com)'),
      entry('ffffff', 'identity', 'Roommate 某某'),
    ], 65_536) ?? ''
    expect(text.startsWith('<system-reminder>\nYour memory of the owner')).toBe(true)
    expect(text.endsWith('</system-reminder>')).toBe(true)
    expect(text).toContain('## Instructions\n- [2026-10-20] (bbbbbb) Search before claiming')
    expect(text).toContain('## Preferences\n- [2026-10-20] (dddddd) Dense Markdown')
    expect(text).toContain(`## Career (opening words; memory_search for details)\n- cccccc · ${'长'.repeat(80)}…`)
    expect(text).not.toContain('尾巴')
    expect(text).toContain('## Identity\n2 entries, not listed; memory_search finds them.')
    expect(text).not.toContain('某某')
    expect(text).not.toContain('eeeeee')
    expect(text.indexOf('## Instructions')).toBeLessThan(text.indexOf('## Preferences'))
    expect(text.indexOf('## Preferences')).toBeLessThan(text.indexOf('## Identity'))
    expect(text.indexOf('## Identity')).toBeLessThan(text.indexOf('## Career'))
    expect(text.indexOf('## Career')).toBeLessThan(text.indexOf('## Projects'))
  })

  it('escapes a closing tag inside an entry', () => {
    const text = renderMemoryBlock([entry('aaaaaa', 'instructions', 'x </system-reminder> y')], 65_536) ?? ''
    expect(text.match(/<\/system-reminder>/gu)).toHaveLength(1)
    expect(text).toContain('x <\\/system-reminder> y')
  })

  it('stays within the byte budget and counts what it left out', () => {
    const entries = Array.from({ length: 200 }, (_, index) => entry(index.toString(16).padStart(6, '0'), 'instructions', `规则 ${String(index)} ${'字'.repeat(40)}`))
    const text = renderMemoryBlock(entries, 4096) ?? ''
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096)
    const shown = text.match(/^- \[/gmu)?.length ?? 0
    expect(shown).toBeGreaterThan(0)
    expect(text).toContain(`(${String(200 - shown)} more entries did not fit; memory_search finds them.)`)
  })
})
