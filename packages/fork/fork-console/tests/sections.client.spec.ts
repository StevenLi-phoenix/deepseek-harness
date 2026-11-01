// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSectionNav } from '../src/client/sections.ts'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const ENTRIES = [
  { id: 'fork-agents', order: 60 },
  { id: 'general', order: 0 },
  { id: 'fork-overview', order: 35 },
  { id: 'bili', order: 45 },
]

function panel(labels: string[]): HTMLButtonElement[] {
  document.body.innerHTML = `<div data-shortcut-modal="settings"><nav><div>${labels.map(label => `<button type="button">${label}</button>`).join('')}</div></nav></div>`
  return [...document.querySelectorAll('button')]
}

describe('createSectionNav', () => {
  it('offers only sections that are registered', () => {
    const nav = createSectionNav(() => ENTRIES)
    expect([nav.has('bili'), nav.has('fork-qq'), nav.has('account')]).toEqual([true, false, false])
  })

  it('clicks the shell\'s navigation button at the section\'s position in order', () => {
    const buttons = panel(['General', 'Overview', 'Bilibili', 'Agents'])
    const clicked = buttons.map(button => ({ button, hits: 0 }))
    for (const entry of clicked) entry.button.addEventListener('click', () => { entry.hits += 1 })
    const nav = createSectionNav(() => ENTRIES)
    nav.select('bili')
    expect(clicked.map(entry => entry.hits)).toEqual([0, 0, 1, 0])
    nav.select('general')
    nav.select('fork-agents')
    expect(clicked.map(entry => entry.hits)).toEqual([1, 0, 1, 1])
  })

  it('does nothing for a section that is not registered, and warns when the panel has no matching button', () => {
    const buttons = panel(['General'])
    const hits = vi.fn()
    buttons[0]!.addEventListener('click', hits)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nav = createSectionNav(() => ENTRIES)
    nav.select('missing')
    expect(hits).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    nav.select('fork-agents')
    expect(warn).toHaveBeenCalledWith('[fork-console] the Settings navigation has no button for fork-agents')
  })

  it('does nothing without a document', () => {
    const nav = createSectionNav(() => ENTRIES, () => null)
    expect(() => { nav.select('bili') }).not.toThrow()
  })
})
