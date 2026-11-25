/**
 * Which event kinds reach the owner while they sleep.
 */

/** Event kinds sent even while the owner sleeps, unless the configuration names others. */
export const DEFAULT_URGENT_KINDS: readonly string[] = ['host.disk.full', 'host.*.critical', 'bili.risk.*', 'bili.gate.readonly']
