/**
 * The send gate: whether a message goes out now, waits for the owner, or is refused, decided by fixed rules over
 * the account's policy, the turn's origin (read from the Session log by `fork-taint`, never from the model), and the
 * recipients. A clean owner turn still holds a message to an address the owner neither named in the turn nor wrote
 * to before, since words read in an earlier turn may still be in the model's context. A held message is confirmed
 * only by the owner: in Settings, or in a turn the owner started alone whose
 * own words carry the held message's code, so the model cannot confirm what it asked for.
 */

/** What an account may do. */
export type SendPolicy = 'read-only' | 'confirm-all' | 'confirm-untrusted' | 'direct'

/** Every policy, in the order Settings lists them. */
export const SEND_POLICIES: readonly SendPolicy[] = ['read-only', 'confirm-all', 'confirm-untrusted', 'direct']

/** The turn a send runs in, as the tools read it. */
export interface TurnFacts {
  /** The owner started the turn alone and no tool read strangers' words in it. */
  readonly clean: boolean
  /** How the origin is named in logs and notices, e.g. `owner+gmail_read` or `scheduled`. */
  readonly origin: string
  /** The text of the owner's own messages in the open turn (empty outside an owner turn). */
  readonly ownerText: readonly string[]
  /** The Session the tool runs in, for the log. */
  readonly sessionId?: string | undefined
}

/** The gate's answer. */
export type GateDecision =
  | { readonly kind: 'send' }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string }

/** What the gate knows about the recipients. */
export interface RecipientFacts {
  /** Addresses that never need a confirmation: the owner's own accounts and the configured list, lower-cased. */
  readonly trusted: ReadonlySet<string>
  /**
   * Addresses the owner vouched for, lower-cased: named in the owner's own words this turn, or written to from this
   * account before (its sent mail). Read only for a clean owner turn.
   */
  readonly vouched: ReadonlySet<string>
}

/**
 * Decide a new send.
 * @param policy - the account's policy.
 * @param turn - the turn's facts.
 * @param recipients - every To, Cc, and Bcc address, lower-cased.
 * @param facts - the trusted and vouched addresses.
 * @returns send, hold (with the reason the owner reads), or refuse (with the reason the model reads).
 */
export function decideSend(policy: SendPolicy, turn: TurnFacts, recipients: readonly string[], facts: RecipientFacts): GateDecision {
  switch (policy) {
    case 'read-only':
      return { kind: 'refuse', reason: 'this account is read-only: the owner allows no drafts, sends, or changes from you' }
    case 'direct':
      return { kind: 'send' }
    case 'confirm-all':
      return { kind: 'hold', reason: '这个账号每封信都要你确认' }
    case 'confirm-untrusted': {
      if (recipients.length > 0 && recipients.every(address => facts.trusted.has(address))) return { kind: 'send' }
      if (!turn.clean) return { kind: 'hold', reason: `这一轮不是你单独发起的，或读过外来内容（${turn.origin}）` }
      const strangers = recipients.filter(address => !facts.trusted.has(address) && !facts.vouched.has(address))
      if (strangers.length === 0) return { kind: 'send' }
      return { kind: 'hold', reason: `${strangers.join('、')} 不在你这一轮的话里，这个账号也没给对方发过信` }
    }
    /* v8 ignore next 2 -- SendPolicy is a closed union; the default only makes a new policy a compile error. */
    default:
      return assertNever(policy)
  }
}

/**
 * Whether the owner named an address in their own words this turn.
 * @param turn - the turn's facts.
 * @param address - the address, lower-cased.
 * @returns true when some owner message holds it, in any case.
 */
export function namedByOwner(turn: TurnFacts, address: string): boolean {
  return turn.ownerText.some(text => text.toLowerCase().includes(address))
}

/**
 * Whether the owner's own words in this turn confirm a held message.
 * @param turn - the turn's facts.
 * @param code - the held message's code.
 * @returns true in a clean owner turn whose owner text holds the code as a word, in any case.
 */
export function ownerConfirms(turn: TurnFacts, code: string): boolean {
  if (!turn.clean) return false
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${code}(?:$|[^A-Za-z0-9])`, 'iu')
  return turn.ownerText.some(text => pattern.test(text))
}

/** A closed union ran out of cases. */
function assertNever(value: never): never {
  throw new Error(`unhandled send policy ${String(value)}`)
}
