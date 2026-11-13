/**
 * What the Host configuration route answers and accepts, shared by both halves as types only. The Host reads a
 * plugin entry's schema together with its stored values and sends the form already built: one tree of groups and
 * leaves, each leaf carrying the value in force, the schema default, and the layer that set it. Credentials never
 * ride: a credential leaf says only whether it holds a value.
 */

/** Route of the read (`GET ?entries=a,b`) and the save (`POST`). */
export const CONFIG_PATH = '/api/plugin-config'

/** The same route without the leading slash, for document-relative requests that keep a served mount working. */
export const CONFIG_ROUTE = CONFIG_PATH.slice(1)

/** Most entries one read names. */
export const MAX_ENTRIES = 16

/** Most field paths one read or save excludes. */
export const MAX_EXCLUDE = 64

/** Most edits one save carries. */
export const MAX_OPS = 200

/** An entry id as profile patches spell it. */
export const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/

/** Data that survives JSON. */
export type ConfigValue = null | boolean | number | string | ConfigValue[] | { [key: string]: ConfigValue }

/** The layer that decides a field's value, lowest first. */
export type ConfigLayer = 'default' | 'bundle' | 'owner' | 'home'

/** Why a field cannot be edited here. */
export type LockReason = 'home' | 'expression' | 'secret'

/** A schema description: one text, or one per locale (the empty key is the fallback). */
export type DescriptionText = string | Readonly<Record<string, string>>

/** What every node of the form shares. */
interface FieldBase {
  /** The last segment of the path. */
  readonly key: string
  /** Path from the entry's config root. */
  readonly path: readonly string[]
  readonly description?: DescriptionText
}

/** An object in the schema: its children are the fields below it. */
export interface GroupField extends FieldBase {
  readonly kind: 'group'
  readonly children: readonly FieldNode[]
}

/**
 * How a leaf is edited: free text, an environment variable name, a switch, a number, one of a few values, one
 * string per line, JSON for any other shape, or nothing for a credential.
 */
export type LeafKind = 'string' | 'credential-ref' | 'number' | 'boolean' | 'select' | 'string-list' | 'json' | 'secret'

/** A field that holds a value. */
export interface LeafField extends FieldBase {
  readonly kind: LeafKind
  /** The layer that set the value in force. */
  readonly layer: ConfigLayer
  /** The value in force as stored; absent when no layer sets it, always absent for a credential. */
  readonly value?: ConfigValue
  /** The schema's default; absent when it has none, always absent for a credential. */
  readonly default?: ConfigValue
  /** Only where the owner's patch sets the field: what the bundle layer gives, which a reset returns to; absent if it sets nothing. */
  readonly base?: ConfigValue
  readonly required: boolean
  /** The schema marks the field `volatile`: a change applies to the running plugin without reloading it. */
  readonly volatile?: true
  /** A credential slot: whether it holds a value. Only on `secret`. */
  readonly set?: boolean
  readonly min?: number
  readonly max?: number
  /** `1` marks a whole-number field. */
  readonly step?: number
  /** The values a `select` offers. */
  readonly options?: readonly ConfigValue[]
  /** Why the field cannot be edited; absent when it can. */
  readonly readOnly?: LockReason
}

/** One node of the form. */
export type FieldNode = GroupField | LeafField

/** One plugin entry as the form shows it. */
export interface ConfigEntryView {
  readonly id: string
  /** Whether the composition has an entry with this id. */
  readonly found: boolean
  /** Whether its plugin is running, so its schema could be read. */
  readonly active: boolean
  /** The home patch sets this entry's config, so a save here would be shadowed. */
  readonly locked: boolean
  /** Changes whenever the stored config or the lower layers change; a save sends the one it was staged against. */
  readonly revision: string
  /** The fields the owner's patch sets away from the bundle. */
  readonly overrides: number
  readonly fields: readonly FieldNode[]
}

/** The read's answer. */
export interface ConfigDescribe {
  readonly entries: readonly ConfigEntryView[]
}

/**
 * One edit of a save. `set` stores a value; `unset` returns the field to what the bundle sets (the schema default
 * where it sets nothing); `clear` removes the field, so the schema default applies whatever the bundle sets.
 */
export type ConfigOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: ConfigValue }
  | { readonly op: 'unset'; readonly path: readonly string[] }
  | { readonly op: 'clear'; readonly path: readonly string[] }

/** The save's request. */
export interface ConfigSaveRequest {
  readonly id: string
  readonly revision: string
  readonly ops: readonly ConfigOp[]
  /** Dotted field paths the form did not show (a dedicated editor owns them); they are neither written nor part of the revision. */
  readonly exclude?: readonly string[]
}

/** Why a save did not land. */
export type ConfigSaveFailure = 'bad-request' | 'not-found' | 'conflict' | 'home-locked' | 'invalid' | 'failed'

/** The save's answer. */
export type ConfigSaveResult =
  | {
    readonly ok: true
    readonly revision: string
    readonly changed: readonly string[]
    /** The plugin reloads: a changed field is not `volatile`. */
    readonly reload: boolean
  }
  | { readonly ok: false; readonly reason: ConfigSaveFailure; readonly message: string }

/**
 * Format a field path for display.
 * @param path - a field path.
 * @returns the path as dotted text, for logs and display.
 */
export function pathLabel(path: readonly string[]): string {
  return path.join('.')
}

/**
 * Flatten a form into its leaves.
 * @param nodes - the nodes of a form.
 * @returns every leaf below them, depth first.
 */
export function leavesOf(nodes: readonly FieldNode[]): LeafField[] {
  return nodes.flatMap(node => node.kind === 'group' ? leavesOf(node.children) : [node])
}
