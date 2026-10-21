/** Subscription validation shared by the configuration and run-time `subscribe()`. */

/** Narrow to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a list whose entries are all strings. */
function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/** True for a safe integer at or above `min`. */
function isIntegerAtLeast(value: unknown, min: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

/** True for a string that is not blank. */
function isFilled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** First problem of a `session` subscription's settings. */
function sessionProblem(id: string, session: unknown): string | undefined {
  const label = `session subscription "${id}"`
  if (!isRecord(session) || typeof session.workspacePath !== 'string' || !session.workspacePath.startsWith('/')) {
    return `${label} needs an absolute session.workspacePath`
  }
  if (!isFilled(session.instructions)) return `${label} needs session.instructions`
  if (!isFilled(session.agentPreset)) return `${label}: session.agentPreset must be non-empty`
  if (!isFilled(session.permissionPreset)) return `${label}: session.permissionPreset must be non-empty`
  if (!isIntegerAtLeast(session.maxPromptEvents, 1)) return `${label}: session.maxPromptEvents must be a positive integer`
  if (!isIntegerAtLeast(session.maxTextChars, 1)) return `${label}: session.maxTextChars must be a positive integer`
  if (session.titlePrefix !== undefined && typeof session.titlePrefix !== 'string') return `${label}: session.titlePrefix must be a string`
  return undefined
}

/**
 * Explain why a value cannot be routed as a subscription. Configuration
 * rows and run-time subscriptions pass the same checks; uniqueness is the
 * caller's concern.
 * @param value - candidate subscription.
 * @returns the first problem, or undefined for a valid subscription.
 */
export function subscriptionProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'subscription must be an object'
  if (!isFilled(value.id)) return 'subscription id must be non-empty'
  const id = value.id as string
  for (const field of ['sources', 'kinds', 'subjects'] as const) {
    if (!isStringList(value[field])) return `subscription "${id}": ${field} must be a list of strings`
  }
  if (value.action !== 'notify' && value.action !== 'session') return `subscription "${id}": action must be "notify" or "session"`
  if (!isIntegerAtLeast(value.coalesceMs, 0)) return `subscription "${id}": coalesceMs must be a non-negative integer`
  if (!isIntegerAtLeast(value.maxPerHour, 1)) return `subscription "${id}": maxPerHour must be a positive integer`
  return value.action === 'session' ? sessionProblem(id, value.session) : undefined
}

/** Why `subscribe()` refused a subscription. */
export type LsySubscriptionErrorCode = 'invalid_subscription' | 'duplicate_id'

/** Rejection of a run-time subscription the bus cannot route or whose id is taken. */
export class LsySubscriptionError extends Error {
  override readonly name = 'LsySubscriptionError'

  /**
   * @param code - `invalid_subscription` or `duplicate_id`.
   * @param message - human-readable reason.
   */
  constructor(readonly code: LsySubscriptionErrorCode, message: string) {
    super(message)
  }
}
