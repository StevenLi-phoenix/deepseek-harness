/**
 * Bounds on what a model-written tool call may ask for. Security invariants of the tools, not deployment choices: `Config` defaults
 * must stay inside them.
 */

/** Id of a watch or a route. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
/** Longest coalesce window a call may ask for: one day. */
export const MAX_COALESCE_SECONDS = 86_400
/** Highest hourly batch limit a call may ask for. */
export const MAX_PER_HOUR = 60
