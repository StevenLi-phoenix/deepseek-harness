/**
 * The staged edits of one entry's form: what each field's draft means, which drafts a save would send, and how
 * they read in the review before it. Pure functions over the Host's field tree.
 */

import {
  leavesOf, type ConfigEntryView, type ConfigOp, type DescriptionText, type FieldNode, type ConfigValue, type LeafField,
} from '../view.ts'

/** What the owner staged for one field: typed text, a switch position, or a return to the layer below. */
export type Draft =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'reset' }

/** Staged edits by field path (see {@link pathKey}). */
export type Drafts = ReadonlyMap<string, Draft>

/** One line of the review before a save. */
export interface Change {
  readonly key: string
  readonly path: readonly string[]
  readonly action: 'set' | 'clear' | 'reset'
  /** The value in force now, as text; empty when none. */
  readonly before: string
  /** The value after the save, as text; empty when none. */
  readonly after: string
  /** The field applies without reloading the plugin. */
  readonly volatile: boolean
}

/** What a save would do. */
export interface Plan {
  readonly ops: readonly ConfigOp[]
  readonly changes: readonly Change[]
  /** Paths whose draft is not a value the field accepts. */
  readonly invalid: readonly string[]
  /** A field the save changes is not `volatile`, so the plugin reloads. */
  readonly reload: boolean
}

/** Longest value the review prints before cutting it. */
const REVIEW_LIMIT = 80

/**
 * Join a field path into the key that `Drafts` and `Change` use.
 * @param path - field path.
 * @returns the key; equal paths give equal keys.
 */
export function pathKey(path: readonly string[]): string {
  return path.join('\u0000')
}

/**
 * Pick the value a leaf shows now.
 * @param leaf - the field.
 * @returns the stored value, else the schema default, else undefined.
 */
export function shownValue(leaf: LeafField): ConfigValue | undefined {
  return leaf.value ?? leaf.default
}

/**
 * Format a field value as the text its control holds.
 * @param kind - how the field is edited.
 * @param value - a value of the field.
 * @returns the text the field's control holds for it.
 */
export function valueText(kind: LeafField['kind'], value: ConfigValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (kind === 'string-list') return Array.isArray(value) ? value.map(String).join('\n') : ''
  if (kind === 'json') return JSON.stringify(value, null, 2)
  if (kind === 'select' || typeof value === 'object') return JSON.stringify(value)
  return typeof value === 'string' ? value : String(value)
}

/**
 * Format the value a leaf shows now as control text.
 * @param leaf - the field.
 * @returns the text the control holds before any edit.
 */
export function initialText(leaf: LeafField): string {
  return valueText(leaf.kind, shownValue(leaf))
}

type Parsed =
  | { readonly ok: true; readonly op: 'set'; readonly value: ConfigValue }
  | { readonly ok: true; readonly op: 'clear' }
  | { readonly ok: false }

/**
 * Turn control text back into an edit of one field.
 * @param leaf - the field.
 * @param text - what the owner typed or chose.
 * @returns the edit the text stands for; an empty text of an optional field clears it.
 */
export function parseText(leaf: LeafField, text: string): Parsed {
  const trimmed = text.trim()
  const clear = { ok: true, op: 'clear' } as const
  switch (leaf.kind) {
    case 'string':
    case 'credential-ref':
      if (trimmed === '') return leaf.required ? { ok: false } : clear
      return { ok: true, op: 'set', value: trimmed }
    case 'number': {
      if (trimmed === '') return leaf.required ? { ok: false } : clear
      const value = Number(trimmed)
      const bad = !Number.isFinite(value) || (leaf.step === 1 && !Number.isInteger(value))
        || (leaf.min !== undefined && value < leaf.min) || (leaf.max !== undefined && value > leaf.max)
      return bad ? { ok: false } : { ok: true, op: 'set', value }
    }
    case 'string-list':
      return { ok: true, op: 'set', value: text.split('\n').map(line => line.trim()).filter(line => line !== '') }
    case 'select': {
      const chosen = (leaf.options ?? []).find(option => JSON.stringify(option) === text)
      return chosen === undefined ? { ok: false } : { ok: true, op: 'set', value: chosen }
    }
    case 'json': {
      if (trimmed === '') return leaf.required ? { ok: false } : clear
      try {
        return { ok: true, op: 'set', value: JSON.parse(trimmed) as ConfigValue }
      } catch (_notJson) {
        // Not JSON yet: the field shows as invalid and blocks the save.
        return { ok: false }
      }
    }
    case 'boolean':
    case 'secret':
      return { ok: false }
    /* v8 ignore next 4 -- exhaustiveness guard: every member of the closed LeafKind union has a case above. */
    default: {
      const unreachable: never = leaf.kind
      return unreachable
    }
  }
}

/**
 * Format a value for the review list.
 * @param value - the value, or undefined for none.
 * @returns one line, cut with an ellipsis after 80 characters; empty for undefined and null.
 */
export function brief(value: ConfigValue | undefined): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.join(', ')
    : JSON.stringify(value)
  return text.length > REVIEW_LIMIT ? `${text.slice(0, REVIEW_LIMIT - 1)}…` : text
}

function sameValue(a: ConfigValue | undefined, b: ConfigValue | undefined): boolean {
  /* v8 ignore next -- a is a set value at each caller. */
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function plan1(leaf: LeafField, draft: Draft): { change: Change; op: ConfigOp } | 'same' | 'invalid' {
  const key = pathKey(leaf.path)
  const volatile = leaf.volatile === true
  const before = shownValue(leaf)
  if (draft.kind === 'reset') {
    if (leaf.layer !== 'owner') return 'same'
    return {
      op: { op: 'unset', path: leaf.path },
      change: { key, path: leaf.path, action: 'reset', before: brief(before), after: brief(leaf.base ?? leaf.default), volatile },
    }
  }
  if (draft.kind === 'bool') {
    return draft.value === (before === true)
      ? 'same'
      : {
        op: { op: 'set', path: leaf.path, value: draft.value },
        change: { key, path: leaf.path, action: 'set', before: String(before === true), after: String(draft.value), volatile },
      }
  }
  if (draft.text === initialText(leaf)) return 'same'
  const parsed = parseText(leaf, draft.text)
  if (!parsed.ok) return 'invalid'
  if (parsed.op === 'clear') {
    return {
      op: { op: 'clear', path: leaf.path },
      change: { key, path: leaf.path, action: 'clear', before: brief(before), after: brief(leaf.default), volatile },
    }
  }
  if (sameValue(parsed.value, before)) return 'same'
  return {
    op: { op: 'set', path: leaf.path, value: parsed.value },
    change: { key, path: leaf.path, action: 'set', before: brief(before), after: brief(parsed.value), volatile },
  }
}

/**
 * Compare staged drafts with what each field shows and plan the save.
 * @param entry - the entry as the Host last described it.
 * @param drafts - the staged edits.
 * @returns the edits a save would send, their review lines, and the drafts the fields do not accept.
 */
export function planEdits(entry: ConfigEntryView, drafts: Drafts): Plan {
  const ops: ConfigOp[] = []
  const changes: Change[] = []
  const invalid: string[] = []
  for (const leaf of leavesOf(entry.fields)) {
    const draft = drafts.get(pathKey(leaf.path))
    if (draft === undefined || leaf.readOnly !== undefined) continue
    const result = plan1(leaf, draft)
    if (result === 'invalid') invalid.push(pathKey(leaf.path))
    else if (result !== 'same') {
      ops.push(result.op)
      changes.push(result.change)
    }
  }
  return { ops, changes, invalid, reload: changes.some(change => !change.volatile) }
}

/**
 * Count the leaves below a list of nodes.
 * @param nodes - form nodes, groups included.
 * @returns how many leaves they hold in total, and how many of those the owner's patch sets.
 */
export function countLeaves(nodes: readonly FieldNode[]): { total: number; owner: number } {
  const leaves = leavesOf(nodes)
  return { total: leaves.length, owner: leaves.filter(leaf => leaf.layer === 'owner').length }
}

/**
 * Choose the description text for a locale.
 * @param text - a schema description: one text, or one per locale (the empty key is the fallback).
 * @param locale - the active locale id.
 * @returns the text for the locale, else English, else the fallback, else any.
 */
export function pickDescription(text: DescriptionText | undefined, locale: string): string {
  if (text === undefined) return ''
  if (typeof text === 'string') return text
  /* v8 ignore next -- split always yields a first element. */
  const language = locale.split('-')[0] ?? locale
  return text[locale] ?? text[language] ?? text['en'] ?? text[''] ?? Object.values(text)[0] ?? ''
}
