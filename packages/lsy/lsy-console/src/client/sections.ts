/**
 * Moving between Settings sections from inside one. The settings shell owns navigation and hands a section only `close`, so a
 * "Manage" link finds the shell's own navigation button for the target section and clicks it, the way a pointer would. The
 * button is found by position: the shell lists sections sorted by `order`, and so does this. A link is offered only for a
 * section that is registered, so a section another deployment does not mount never shows a dead link.
 */

/** One registered section, as the slot ledger lists it. */
export interface SectionEntry {
  readonly id: string
  readonly order: number
}

/** What a section needs to link to another. */
export interface SectionNav {
  /** Whether a section with this id is registered. */
  has(id: string): boolean
  /** Switch the open Settings panel to a section; does nothing when it is not registered or the panel is not open. */
  select(id: string): void
}

/**
 * @param entries - the registered `settings.section` entries.
 * @param root - where the open panel lives; the browser document by default.
 * @returns the navigation helper.
 */
export function createSectionNav(entries: () => readonly SectionEntry[], root: () => ParentNode | null = () => ('document' in globalThis ? globalThis.document : null)): SectionNav {
  const sorted = (): SectionEntry[] => [...entries()].sort((a, b) => a.order - b.order)
  return {
    has: id => sorted().some(entry => entry.id === id),
    select: (id) => {
      const index = sorted().findIndex(entry => entry.id === id)
      if (index < 0) return
      const buttons = root()?.querySelectorAll<HTMLButtonElement>('[data-shortcut-modal="settings"] nav button')
      const button = buttons?.item(index)
      if (!button) {
        console.warn(`[lsy-console] the Settings navigation has no button for ${id}`)
        return
      }
      button.click()
    },
  }
}
