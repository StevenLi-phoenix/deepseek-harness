/**
 * Choosing an option of a native `<select>` from the text a model typed. A
 * model names the option a person reads ("United States"), or sometimes the
 * value behind it ("US"); the label wins, then the value, then one option the
 * text uniquely starts or appears in, so "United" picks "United States" only
 * when no "United Kingdom" competes. Disabled options are never chosen.
 *
 * @module @deepseek-ai/dsh-headless-browser/select
 */

/** One option as the page lists it. */
export interface SelectOption {
  /** The text a person reads. */
  readonly label: string
  /** The value the form submits. */
  readonly value: string
  /** Whether the option is disabled. */
  readonly disabled: boolean
}

/**
 * Read the options of a `<select>` inside the page. Playwright serialises this
 * function, so it must not reference anything outside itself.
 * @param element - the select element.
 * @returns every option, in order; nothing for any other element.
 */
export function readOptions(element: Element): SelectOption[] {
  if (!(element instanceof HTMLSelectElement)) return []
  return Array.from(element.options).map(option => ({ label: option.label, value: option.value, disabled: option.disabled }))
}

/**
 * Whether an element is a searchable dropdown's text input: an `input` that
 * names itself a combobox or autocompletes from a list (react-select carries
 * only `aria-autocomplete="list"`). Playwright serialises this function.
 * @param element - the element a type resolved to.
 * @returns true for a combobox input.
 */
export function isComboboxInput(element: Element): boolean {
  if (!(element instanceof HTMLInputElement)) return false
  return element.getAttribute('role') === 'combobox' || ['list', 'both'].includes(element.getAttribute('aria-autocomplete') ?? '')
}

/**
 * The visible options of the list a combobox input controls, read inside the
 * page. The list is the element `aria-controls` (or `aria-owns`) names, and an
 * option is a visible `[role=option]` in it; its `value` carries the option's
 * id so the host can click it. Playwright serialises this function.
 * @param input - the combobox input.
 * @returns the options in order; nothing while the list is closed or empty.
 */
export function readComboboxOptions(input: Element): SelectOption[] {
  const id = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns')
  const list = id === null || id === '' ? null : input.ownerDocument.getElementById(id)
  if (list === null) return []
  return Array.from(list.querySelectorAll('[role="option"]'))
    .filter((option) => {
      const box = option.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && option.id !== ''
    })
    .map(option => ({
      label: (option.textContent ?? '').replace(/\s+/gu, ' ').trim(),
      value: option.id,
      disabled: option.getAttribute('aria-disabled') === 'true',
    }))
}

/**
 * Validate options that crossed the page boundary.
 * @param value - whatever `evaluate` returned.
 * @returns the options, when every entry is shaped like one.
 * @throws Error - when an entry is not an option.
 */
export function readSelectOptions(value: unknown): readonly SelectOption[] {
  if (!Array.isArray(value)) throw new Error('the option probe returned no list')
  return value.map((entry: unknown) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const { label, value: optionValue, disabled } = record
    if (typeof label !== 'string' || typeof optionValue !== 'string' || typeof disabled !== 'boolean') {
      throw new Error('the option probe returned an entry that is not an option')
    }
    return { label, value: optionValue, disabled }
  })
}

/**
 * The option a typed text names.
 * @param options - the select's options, in order.
 * @param text - what the model typed.
 * @returns the option's index, or nothing when no option, or more than one, matches.
 */
export function matchOption(options: readonly SelectOption[], text: string): number | undefined {
  const wanted = normalise(text)
  if (wanted === '') return undefined
  const enabled = options.map((option, index) => ({ option, index })).filter(entry => !entry.option.disabled)
  const unique = (found: readonly { readonly index: number }[]): number | undefined => (found.length === 1 ? found[0]?.index : undefined)
  const label = enabled.find(entry => normalise(entry.option.label) === wanted)
  if (label !== undefined) return label.index
  const value = enabled.find(entry => entry.option.value.trim().toLowerCase() === wanted)
  if (value !== undefined) return value.index
  return unique(enabled.filter(entry => normalise(entry.option.label).startsWith(wanted)))
    ?? unique(enabled.filter(entry => normalise(entry.option.label).includes(wanted)))
}

/** Lowercase text with runs of whitespace folded to one space. */
function normalise(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}
