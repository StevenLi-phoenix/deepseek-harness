/**
 * What the Settings section shows: every account bili-svc lists, its gate, brake, and ledger, QR
 * sign-ins in progress, the Reply Gate's comment speaker, the owner's main account, and the daily
 * share. With the manage token the status comes from the management read; without it, from the
 * agent's own token, read-only.
 */
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { errorText, type ServiceStatus } from './client.ts'
import type { ManageGate } from './manage.ts'
import type { ManageSettings, ManageSnapshot } from './settings.ts'
import type { DailyShare } from './share.ts'
import type { AccountStatus } from './status.ts'
import type { biliDomain } from './storage.ts'
import { clean } from './text.ts'
import { SESSION_STATES, type ActionResult, type BiliView, type GateView, type ManagedAccount, type SessionState } from './view.ts'

/** What the Settings view needs of the account. */
export interface SettingsViewHost {
  readonly ready: Promise<Domain<typeof biliDomain>>
  /** Management reads under the manage token, and the QR sign-ins in progress. */
  readonly settings: Pick<ManageSettings, 'hasToken' | 'read' | 'logins'>
  /** bili-svc's status as the agent's own token reads it. */
  readonly status: Pick<AccountStatus, 'accountView' | 'accountOf' | 'commentSpeaker'>
  /** The daily share's view. */
  readonly share: Pick<DailyShare, 'view'>
  /** The owner's main account, or undefined while unset. */
  ownerMid(): number | undefined
  /** bili-svc's id of the agent's account. */
  readonly account: string
  /** Name of the credential holding the manage token. */
  readonly manageTokenEnv: string
  /** IANA time zone the view names. */
  readonly timeZone: string
  /** Aborted when the account stops. */
  readonly signal: AbortSignal
  /** Warning log line. */
  warn(message: string): void
}

/** The gate as the agent's own token reports it: no brake detail and no counters. */
function minimalGate(gate: ServiceStatus['gate']): GateView | null {
  return gate === undefined ? null : { mode: clean(gate.mode, 40), readonly: gate.readonly, brake: null, used: null, caps: null }
}

/** The gate as the manage token reports it. */
function fullGate(gate: ManageGate | null): GateView | null {
  return gate === null ? null : { mode: gate.mode, readonly: gate.readonly, brake: gate.brake, used: gate.used, caps: gate.caps }
}

/** The Settings section's view. bili-svc's answers carry no cookie or token, and the QR keys stay on the Host. */
export class SettingsView {
  /** @param host - storage, the management and status reads, the daily share, the owner account, and the logger. */
  constructor(private readonly host: SettingsViewHost) {}

  /**
   * Read the view.
   * @param result - what the action that led to this view did; null for a plain read.
   * @param ledgerRows - ledger rows to read.
   * @returns the view.
   */
  async read(result: ActionResult | null, ledgerRows: number): Promise<BiliView> {
    const domain = await this.host.ready
    const manage = await this.host.settings.hasToken()
    let snapshot: ManageSnapshot | undefined
    let manageError: string | null = null
    if (manage) {
      try {
        snapshot = await this.host.settings.read(ledgerRows, this.host.signal)
      } catch (error: unknown) {
        manageError = errorText(error)
        this.host.warn(`bili: the manage read failed: ${manageError}`)
      }
    }
    const agent = snapshot === undefined ? await this.host.status.accountView() : undefined
    const checkedAt = Date.now()
    const rows = snapshot?.status.accounts ?? agent?.status?.accounts.map(account => ({
      ...account, session: (SESSION_STATES as readonly string[]).includes(account.session) ? account.session as SessionState : 'missing' as const,
      refreshMode: null, login: false, refreshedAt: null, importedAt: null, deadReason: null,
    })) ?? []
    const accounts: ManagedAccount[] = rows.map(row => ({ ...row, agent: row.id === this.host.account }))
    const speakerId = manage && manageError === null ? await this.host.status.commentSpeaker() : null
    const speakerRow = speakerId === null ? undefined : accounts.find(row => row.id === speakerId)
    const gate = snapshot === undefined ? minimalGate(agent?.gate) : fullGate(snapshot.status.gate)
    /* v8 ignore next 2 -- snapshot is defined whenever agent is undefined. */
    return {
      account: agent?.view ?? this.host.status.accountOf(snapshot?.status ?? { accounts: [] }, checkedAt),
      gate,
      accounts,
      speaker: speakerId === null ? null : { id: speakerId, display: speakerRow?.display === undefined || speakerRow.display === '' ? speakerId : speakerRow.display },
      ledger: snapshot?.ledger ?? null,
      logins: this.host.settings.logins(),
      manage: manage && manageError === null,
      manageEnv: this.host.manageTokenEnv,
      manageError,
      result,
      ownerMid: this.host.ownerMid() ?? 0,
      ownerUpdatedAt: domain.table('owner').get('main')?.updatedAt ?? null,
      timeZone: this.host.timeZone,
      share: await this.host.share.view(),
    }
  }
}
