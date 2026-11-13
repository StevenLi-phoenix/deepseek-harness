/**
 * The connected accounts: each with its address, its send policy as a select with the chosen policy explained, the
 * sends of the last 24 hours against the cap, the last success and error, 重新登录 (stressed when Google refused the
 * stored sign-in), and 断开 behind a confirmation. Then the form that connects a new account through Google sign-in
 * in this tab.
 */

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { ACCOUNT_ID_PATTERN, POLICIES, type AccountRow, type PolicyView } from '../view.ts'
import { ADD_CONTROL, NEW_ACCOUNT_POLICY, ago, looksLikeAddress, type Translate } from './gmail.ts'
import type { GmailKey } from './locales.ts'
import { ActionError, type PartProps } from './parts.tsx'
import css from './GmailSection.module.css'

const POLICY_KEY = {
  'read-only': 'policy.read-only',
  'confirm-all': 'policy.confirm-all',
  'confirm-untrusted': 'policy.confirm-untrusted',
  'direct': 'policy.direct',
} as const satisfies Record<PolicyView, GmailKey>

const POLICY_HINT_KEY = {
  'read-only': 'policy.read-only.hint',
  'confirm-all': 'policy.confirm-all.hint',
  'confirm-untrusted': 'policy.confirm-untrusted.hint',
  'direct': 'policy.direct.hint',
} as const satisfies Record<PolicyView, GmailKey>

/** The four policies as options, strictest first. */
function PolicyOptions({ t }: { t: Translate }): ReactNode {
  return POLICIES.map(policy => <option key={policy} value={policy}>{t(POLICY_KEY[policy])}</option>)
}

/** The chosen policy's explanation; sending without a confirmation reads as a warning. */
function PolicyHint({ policy, t, id }: { policy: PolicyView; t: Translate; id?: string | undefined }): ReactNode {
  return <span id={id} className={policy === 'direct' ? css.warnText : css.hint}>{t(POLICY_HINT_KEY[policy])}</span>
}

function AccountCard({ account, parts }: { account: AccountRow; parts: PartProps }): ReactNode {
  const { view, at, busy, failure, t, act } = parts
  // The policy picked while its save is in flight, so the select does not jump back until the Host answers.
  const [chosen, setChosen] = useState<PolicyView | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const titleId = useId()
  const policyControl = `policy:${account.id}`
  const removeControl = `remove:${account.id}`
  const signInControl = `sign-in:${account.id}`
  const policy = chosen ?? account.policy
  const held = view.pending.filter(row => row.status === 'held' && row.account === account.id).length
  const atCap = account.sentToday >= view.maxSendsPerDay
  return (
    <article className={css.card} aria-labelledby={titleId} data-reconnect={account.needsReconnect ? '' : undefined}>
      <div className={css.cardHeader}>
        <span className={css.identity}>
          <span id={titleId} className={css.accountId}>{account.id}</span>
          <span className={css.email}>{account.name === '' ? account.email : `${account.name} <${account.email}>`}</span>
        </span>
        {account.needsReconnect ? <span className={css.badge}>{t('account.reconnectBadge')}</span> : null}
      </div>
      <label className={css.control}>
        <span className={css.label}>{t('account.policy')}</span>
        <select
          className={css.select}
          value={policy}
          disabled={busy !== null}
          onChange={(event) => {
            const next = event.target.value as PolicyView
            setChosen(next)
            void act({ action: 'policy', account: account.id, policy: next }).finally(() => { setChosen(null) })
          }}
        >
          <PolicyOptions t={t} />
        </select>
      </label>
      {busy === policyControl ? <span className={css.hint}>{t('account.saving')}</span> : <PolicyHint policy={policy} t={t} />}
      <span className={css.meta}>
        <span className={atCap ? css.warnText : undefined}>{t('account.sent', { count: account.sentToday, max: view.maxSendsPerDay })}</span>
        {' · '}
        {account.lastOkAt === null ? t('account.lastOkNever') : t('account.lastOk', { ago: ago(account.lastOkAt, at, t) })}
      </span>
      {account.lastError === null ? null : <span className={css.warnText}>{t('account.lastError', { error: account.lastError })}</span>}
      {disconnecting
        ? (
          <div className={css.confirm} role="group" aria-label={t('account.removeConfirm')}>
            <span>
              {held > 0 ? t('account.removeWarningHeld', { account: account.id, count: held }) : t('account.removeWarning', { account: account.id })}
            </span>
            <div className={css.actions}>
              <button
                type="button"
                className={css.danger}
                disabled={busy !== null}
                aria-busy={busy === removeControl ? true : undefined}
                onClick={() => { void act({ action: 'remove', account: account.id }) }}
              >
                {busy === removeControl ? t('account.removing') : t('account.removeConfirm')}
              </button>
              <button type="button" className={css.secondary} disabled={busy === removeControl} onClick={() => { setDisconnecting(false) }}>
                {t('account.removeCancel')}
              </button>
            </div>
          </div>
        )
        : (
          <div className={css.actions}>
            <button
              type="button"
              className={account.needsReconnect ? css.primary : css.secondary}
              disabled={busy !== null}
              aria-busy={busy === signInControl ? true : undefined}
              onClick={() => { void act({ action: 'sign-in', account: account.id }) }}
            >
              {busy === signInControl ? t('account.reconnecting') : t('account.reconnect')}
            </button>
            <button type="button" className={css.secondary} disabled={busy !== null} onClick={() => { setDisconnecting(true) }}>{t('account.remove')}</button>
          </div>
        )}
      <ActionError failure={failure} controls={[policyControl, removeControl, signInControl]} t={t} />
    </article>
  )
}

/** The form that connects a new account; disabled until the OAuth client is stored. */
function AddAccount({ parts }: { parts: PartProps }): ReactNode {
  const { view, busy, failure, t, act } = parts
  const [id, setId] = useState('')
  // Null until the owner picks a policy.
  const [chosen, setChosen] = useState<PolicyView | null>(null)
  const [hint, setHint] = useState('')
  const [tried, setTried] = useState(false)
  const titleId = useId()
  const idInputId = useId()
  const idHintId = useId()
  const policyInputId = useId()
  const policyHintId = useId()
  const emailInputId = useId()
  const emailHintId = useId()
  const ready = view.client.configured
  const policy = chosen ?? NEW_ACCOUNT_POLICY
  const address = hint.trim()
  const idBad = (tried || id !== '') && !ACCOUNT_ID_PATTERN.test(id)
  const emailBad = tried && address !== '' && !looksLikeAddress(address)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setTried(true)
    if (!ACCOUNT_ID_PATTERN.test(id) || (address !== '' && !looksLikeAddress(address))) return
    void act({ action: 'sign-in', account: id, policy, loginHint: address === '' ? undefined : address }, ADD_CONTROL)
  }
  return (
    <section className={css.card} aria-labelledby={titleId}>
      <span id={titleId} className={css.cardTitle}>{t('add.title')}</span>
      {ready ? null : <p className={css.notice}>{t('add.needsClient')}</p>}
      <form className={css.form} onSubmit={submit} noValidate>
        <fieldset className={css.fieldset} disabled={!ready || busy !== null}>
          <div className={css.formRow}>
            <div className={css.control}>
              <label className={css.label} htmlFor={idInputId}>{t('add.id')}</label>
              <input
                id={idInputId}
                className={css.input}
                value={id}
                maxLength={24}
                placeholder={t('add.idPlaceholder')}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={idBad}
                aria-describedby={idHintId}
                onChange={(event) => { setId(event.target.value.trim().toLowerCase()) }}
              />
              <span id={idHintId} className={idBad ? css.fieldError : css.hint}>{idBad ? t('add.idInvalid') : t('add.idHint')}</span>
            </div>
            <div className={css.control}>
              <label className={css.label} htmlFor={policyInputId}>{t('add.policy')}</label>
              <select
                id={policyInputId}
                className={css.select}
                value={policy}
                aria-describedby={policyHintId}
                onChange={(event) => { setChosen(event.target.value as PolicyView) }}
              >
                <PolicyOptions t={t} />
              </select>
              <PolicyHint policy={policy} t={t} id={policyHintId} />
            </div>
            <div className={css.control}>
              <label className={css.label} htmlFor={emailInputId}>{t('add.email')}</label>
              <input
                id={emailInputId}
                className={css.input}
                type="email"
                value={hint}
                placeholder={t('add.emailPlaceholder')}
                autoComplete="email"
                spellCheck={false}
                aria-invalid={emailBad}
                aria-describedby={emailHintId}
                onChange={(event) => { setHint(event.target.value) }}
              />
              <span id={emailHintId} className={emailBad ? css.fieldError : css.hint}>{emailBad ? t('add.emailInvalid') : t('add.emailHint')}</span>
            </div>
          </div>
          <div className={css.before}>
            <span className={css.label}>{t('add.before')}</span>
            <ul className={css.bullets}>
              <li>{t('add.beforeTab')}</li>
              <li>{t('add.beforeUnverified')}</li>
              <li>{t('add.beforeScope')}</li>
              <li>{t('add.beforeReturn')}</li>
            </ul>
          </div>
          <div className={css.actions}>
            <button type="submit" className={css.primary} aria-busy={busy === ADD_CONTROL ? true : undefined}>
              {busy === ADD_CONTROL ? t('add.connecting') : t('add.connect')}
            </button>
          </div>
        </fieldset>
      </form>
      <ActionError failure={failure} controls={[ADD_CONTROL]} t={t} />
    </section>
  )
}

/**
 * The account cards and the add-account form.
 * @param props - the section's parts.
 * @returns the group.
 */
export function AccountsGroup({ parts }: { parts: PartProps }): ReactNode {
  const { view, t } = parts
  const titleId = useId()
  return (
    <section className={css.group} aria-labelledby={titleId}>
      <div className={css.groupHeader}>
        <span id={titleId} className={css.groupTitle}>{t('accounts.title')}</span>
      </div>
      {view.accounts.length === 0
        ? <p className={css.meta}>{t('accounts.empty')}</p>
        : view.accounts.map(account => <AccountCard key={account.id} account={account} parts={parts} />)}
      <AddAccount parts={parts} />
    </section>
  )
}
