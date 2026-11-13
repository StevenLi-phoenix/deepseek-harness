import { describe, expect, it } from 'vitest'
import { parseClaudeExport } from '../src/export.ts'

const EXPORT = [
  'I\'ll pull every memory file and assemble the export.',
  '',
  '```',
  '## 1. Instructions',
  '',
  '[2026-09-08] - (Network Security project) Search before   claiming.',
  '[2026-10-20] - 不要问问题',
  '',
  '## 2. Identity',
  '[2026-07-18] - Writes Chinese web novels',
  '## 3. Career',
  '[2026-08-25] - Interned at a bank',
  '## 4. Projects',
  '[2026-07-18] - INKFISH P0 — LLM simulation',
  '## 5. Preferences',
  '[2026-09-08] - Prefers dense Markdown',
  '```',
  '',
  'This is the complete set.',
  '- The project memory calls you a graduate student.',
].join('\n')

describe('parseClaudeExport', () => {
  it('maps headings to categories and keeps each entry\'s date', () => {
    expect(parseClaudeExport(EXPORT)).toEqual([
      { category: 'instructions', date: '2026-09-08', text: '(Network Security project) Search before claiming.' },
      { category: 'instructions', date: '2026-10-20', text: '不要问问题' },
      { category: 'identity', date: '2026-07-18', text: 'Writes Chinese web novels' },
      { category: 'career', date: '2026-08-25', text: 'Interned at a bank' },
      { category: 'projects', date: '2026-07-18', text: 'INKFISH P0 — LLM simulation' },
      { category: 'preferences', date: '2026-09-08', text: 'Prefers dense Markdown' },
    ])
  })

  it('accepts Windows line endings and headings without numbers', () => {
    expect(parseClaudeExport('## Career\r\n[2026-01-02] - x\r\n')).toEqual([{ category: 'career', date: '2026-01-02', text: 'x' }])
  })

  it('fails instead of dropping entries under a heading it does not know', () => {
    expect(() => parseClaudeExport('## 6. Pets\n[2026-01-01] - a cat')).toThrow('line 2: entry under unknown heading "Pets"')
    expect(() => parseClaudeExport('[2026-01-01] - orphan')).toThrow('line 1: entry under no heading')
  })
})
