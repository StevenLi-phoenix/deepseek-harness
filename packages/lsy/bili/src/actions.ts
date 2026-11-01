/**
 * Validation of the Settings route's `POST` bodies. The route sits behind the Web sign-in, and the
 * Host still checks every field: an account id is the shape bili-svc uses, a logout repeats the
 * account id as its confirmation, and numbers are bounded.
 */
import z from '@deepseek-ai/schemastery'
import { LEDGER_MAX_ROWS } from './manage.ts'
import { GATE_MODES, type BiliAction } from './view.ts'

/** bili-svc's account ids. */
const ACCOUNT_ID = z.string().pattern(/^[a-z0-9_-]{1,64}$/).required()

/** Per-action schemas; each yields the action's own fields. */
const SCHEMAS: { readonly [A in BiliAction['action']]: z<Extract<BiliAction, { action: A }>> } = {
  'owner': z.object({ action: z.const('owner' as const).required(), mid: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required() }),
  'gate.mode': z.object({ action: z.const('gate.mode' as const).required(), mode: z.union(GATE_MODES).required() }),
  'brake.release': z.object({ action: z.const('brake.release' as const).required() }),
  'login.start': z.object({ action: z.const('login.start' as const).required(), account: ACCOUNT_ID }),
  'login.poll': z.object({ action: z.const('login.poll' as const).required(), account: ACCOUNT_ID }),
  'login.cancel': z.object({ action: z.const('login.cancel' as const).required(), account: ACCOUNT_ID }),
  'session.refresh': z.object({ action: z.const('session.refresh' as const).required(), account: ACCOUNT_ID }),
  'session.check': z.object({ action: z.const('session.check' as const).required(), account: ACCOUNT_ID }),
  'logout': z.object({ action: z.const('logout' as const).required(), account: ACCOUNT_ID, confirm: ACCOUNT_ID }),
  'ledger': z.object({ action: z.const('ledger' as const).required(), limit: z.number().step(1).min(1).max(LEDGER_MAX_ROWS).required() }),
}

/** Whether a name is one of the route's actions. */
function isAction(name: unknown): name is BiliAction['action'] {
  return typeof name === 'string' && Object.hasOwn(SCHEMAS, name)
}

/** The result of {@link parseAction}. */
export type ParsedAction = { readonly ok: true; readonly action: BiliAction } | { readonly ok: false; readonly error: string }

/**
 * Validate one request body.
 * @param body - the parsed JSON.
 * @returns the action with only its own fields, or why the body is refused (no request data in the text).
 */
export function parseAction(body: unknown): ParsedAction {
  const name = typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined
  if (!isAction(name)) return { ok: false, error: 'unknown action' }
  const schema = SCHEMAS[name] as z<BiliAction>
  let action: BiliAction
  try {
    // The schema's signature types its input as the output; the body is checked here, which is why it is parsed.
    const checked = schema(body as BiliAction)
    // The schema passes unknown fields through; the action keeps only its own.
    action = Object.fromEntries(Object.keys(schema.dict ?? {}).map(key => [key, Reflect.get(checked, key)])) as BiliAction
  } catch (error: unknown) {
    return { ok: false, error: `invalid ${name} request: ${error instanceof Error ? error.message : 'bad fields'}` }
  }
  if (action.action === 'logout' && action.confirm !== action.account) return { ok: false, error: 'logout must repeat the account id as confirm' }
  return { ok: true, action }
}
