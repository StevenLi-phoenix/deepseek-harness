/**
 * The account cards of the Bilibili section: one per account bili-svc holds, with its session
 * state, who renews it, and (with the manage token, for accounts bili-svc owns) the QR sign-in,
 * refresh, check, and sign-out controls. Sign-out asks twice. A QR code appears inline under the
 * card; the Host draws it, so only the picture reaches the browser.
 */

import { useState, type ReactNode } from 'react'
import type { LoginView, ManagedAccount } from '../view.ts'
import { agoText, countdown, qrPath } from './format.ts'
import type { CardProps } from './shared.ts'
import css from './BiliAccount.module.css'

/** Translate keys of the busy label of each control. */
const BUSY_LABEL = {
  'login.start': 'busy.login',
  'session.refresh': 'busy.refresh',
  'session.check': 'busy.check',
  'logout': 'busy.logout',
} as const

/** The account controls that need only the account's id. */
type PlainAction = 'login.start' | 'session.refresh' | 'session.check'

function QrCode({ modules, label }: { modules: readonly string[]; label: string }): ReactNode {
  const size = modules.length
  return (
    <svg className={css.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={qrPath(modules)} fill="#18191c" />
    </svg>
  )
}

/** The QR sign-in panel under an account card. */
function LoginPanel({ login, name, props }: { login: LoginView; name: string; props: CardProps }): ReactNode {
  const { t, now, busy, act } = props
  const waiting = login.state === 'waiting' || login.state === 'scanned'
  const retry = busy?.action === 'login.start'
  let status: string
  if (login.state === 'failed') status = login.message === null ? t('login.failed') : t('login.failed.reason', { message: login.message })
  else status = t(`login.${login.state}`)
  return (
    <div className={css.login} role="group" aria-label={t('login.title', { name })} data-login={login.state}>
      <div className={css.loginBody}>
        {login.qr === null ? null : <QrCode modules={login.qr} label={t('login.qr')} />}
        <div className={css.loginText}>
          <span className={css.name}>{t('login.title', { name })}</span>
          <span role="status" data-state={login.state}>{status}</span>
          {waiting ? <span className={css.meta}>{t('login.expires', { time: countdown(login.expiresAt, now) })}</span> : null}
        </div>
      </div>
      <div className={css.actions}>
        {waiting
          ? null
          : (
            <button type="button" className={css.primary} disabled={busy !== null} onClick={() => { act({ action: 'login.start', account: login.account }) }}>
              {retry ? t('busy.login') : t('login.retry')}
            </button>
          )}
        <button type="button" className={css.secondary} disabled={busy !== null} onClick={() => { act({ action: 'login.cancel', account: login.account }) }}>
          {t('login.close')}
        </button>
      </div>
    </div>
  )
}

/** One account's card. */
function AccountCard({ account, login, props }: { account: ManagedAccount; login: LoginView | undefined; props: CardProps }): ReactNode {
  const { view, now, t, busy, act } = props
  const [confirming, setConfirming] = useState(false)
  const name = account.display === '' ? account.id : account.display
  /* v8 ignore next -- `name` is the display or a bili-svc id, never empty, so `?? 'B'` only satisfies the index type. */
  const initial = Array.from(name)[0] ?? 'B'
  const owned = view.manage && account.login
  const mine = (action: keyof typeof BUSY_LABEL): boolean => busy?.action === action && busy.account === account.id
  const button = (action: PlainAction, label: string, extra: { primary?: boolean } = {}): ReactNode => (
    <button
      type="button"
      className={extra.primary === true ? css.primary : css.secondary}
      disabled={busy !== null}
      aria-busy={mine(action) ? true : undefined}
      onClick={() => { act({ action, account: account.id }) }}
    >
      {mine(action) ? t(BUSY_LABEL[action]) : label}
    </button>
  )
  const facts = [
    account.mid > 0 ? t('account.uid', { mid: account.mid }) : undefined,
    t('account.id', { id: account.id }),
    account.refreshedAt === null ? undefined : t('account.refreshed', { ago: agoText(account.refreshedAt, now, t) }),
    account.importedAt === null ? undefined : t('account.imported', { ago: agoText(account.importedAt, now, t) }),
  ].filter(Boolean).join(' · ')
  return (
    <section className={`${css.card} ${css.accountCard}`} aria-label={name} data-account={account.session} data-agent={account.agent ? '' : undefined}>
      <div className={css.identity}>
        <span className={css.avatar} aria-hidden="true">{initial}</span>
        <div className={css.who}>
          <div className={css.nameRow}>
            <span className={css.name}>{name}</span>
            <span className={css.pill} data-state={account.session}>{t(`account.state.${account.session}`)}</span>
            {account.agent ? <span className={css.tag}>{t('account.agent')}</span> : null}
          </div>
          <span className={css.meta}>{facts}</span>
          {account.deadReason === null ? null : <span className={css.reason}>{t('account.dead', { reason: account.deadReason })}</span>}
          {account.refreshMode === null ? null : <span className={css.hint}>{t(`account.mode.${account.refreshMode}`)}</span>}
        </div>
      </div>
      {owned
        ? (
          <div className={css.actions}>
            {button('login.start', t('account.login'), { primary: account.session !== 'ok' })}
            {button('session.refresh', t('account.refresh'))}
            {button('session.check', t('account.check'))}
            {confirming
              ? (
                <>
                  <button
                    type="button"
                    className={css.danger}
                    disabled={busy !== null}
                    aria-busy={mine('logout') ? true : undefined}
                    onClick={() => { setConfirming(false); act({ action: 'logout', account: account.id, confirm: account.id }) }}
                  >
                    {mine('logout') ? t('busy.logout') : t('account.logout.confirm', { name })}
                  </button>
                  <button type="button" className={css.secondary} onClick={() => { setConfirming(false) }}>{t('account.cancel')}</button>
                </>
              )
              : <button type="button" className={css.secondary} disabled={busy !== null} onClick={() => { setConfirming(true) }}>{t('account.logout')}</button>}
          </div>
        )
        : null}
      {login === undefined ? null : <LoginPanel login={login} name={name} props={props} />}
    </section>
  )
}

/**
 * The account cards.
 * @param props - the view and the action callback.
 */
export function Accounts(props: CardProps): ReactNode {
  const { view } = props
  if (view.accounts.length === 0) return null
  return (
    <>
      {view.accounts.map(account => (
        <AccountCard key={account.id} account={account} login={view.logins.find(login => login.account === account.id)} props={props} />
      ))}
    </>
  )
}
