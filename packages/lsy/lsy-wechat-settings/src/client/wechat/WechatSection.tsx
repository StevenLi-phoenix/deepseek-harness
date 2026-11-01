/**
 * The WeChat Settings section: the bot's binding and health, the reply window and the queue behind
 * it, a bind / rebind card with an inline QR panel, and a two-step unbind. It polls while mounted,
 * which the settings shell does only while the section is the open one, and pauses while the page is
 * hidden; an open QR login is polled faster. Nothing it shows can be a token or a message text: the
 * Host masks the ids and answers times, counts, and codes.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { VERIFY_CODE_PATTERN, type ChannelLink, type LoginSnapshot, type WechatView } from '../../wechat-view.ts'
import { agoText, dateTime, spanText, stampTime, type Translate } from './format.ts'
import { qrPath, qrViewSize, isWeixinLink } from './qr.ts'
import { LOGIN_POLL_INTERVAL_MS, POLL_INTERVAL_MS, loginIsOpen, startPolling, type WechatState } from './wechat.ts'
import css from './WechatSection.module.css'

/** The section's injected face (slot `inject`). */
export interface WechatInjected {
  hooks: {
    /** The shared WeChat store. */
    wechat: ObservableSnapshot<WechatState>
  }
  /** One status refresh; a request in flight is shared. */
  refresh: () => void
  /** Open the QR panel with a fresh login. */
  startLogin: () => void
  /** Read the open login once. */
  pollLogin: () => void
  /** Hand the login the number WeChat shows. */
  submitCode: (code: string) => void
  /** End the open login and close the panel. */
  cancelLogin: () => void
  /** Close the panel of a login that is over. */
  dismissLogin: () => void
  /** Unbind the bot. */
  unbind: () => void
}

/** Props delivered by the settings shell. */
export type WechatProps = PropsRuntime<'settings.section'> & InjectFace<WechatInjected> & PropsLocale<'lsy.wechat'>

type Actions = Omit<WechatInjected, 'hooks' | 'refresh'>

function Card({ title, meta, wide, children }: { title: string; meta?: string; wide?: boolean; children: ReactNode }): ReactNode {
  const id = useId()
  return (
    <section className={wide === true ? `${css.card} ${css.wide}` : css.card} aria-labelledby={id}>
      <div className={css.cardHeader}>
        <span id={id} className={css.cardTitle}>{title}</span>
        {meta === undefined ? null : <span className={css.meta}>{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** The pill's tone and wording for the binding and the long-poll. */
function stateOf(view: WechatView): { tone: 'ok' | 'warn' | 'idle'; key: 'state.unbound' | 'state.invalid' | 'state.connected' | 'state.starting' | 'state.retrying' | 'state.stale' } {
  if (view.binding.state === 'unbound') return { tone: 'idle', key: 'state.unbound' }
  if (view.binding.state === 'invalid') return { tone: 'warn', key: 'state.invalid' }
  const byLink: Record<ChannelLink, { tone: 'ok' | 'warn' | 'idle'; key: 'state.unbound' | 'state.connected' | 'state.starting' | 'state.retrying' | 'state.stale' }> = {
    idle: { tone: 'warn', key: 'state.starting' },
    starting: { tone: 'idle', key: 'state.starting' },
    connected: { tone: 'ok', key: 'state.connected' },
    retrying: { tone: 'warn', key: 'state.retrying' },
    stale: { tone: 'warn', key: 'state.stale' },
  }
  return byLink[view.channel.link]
}

function StatusCard({ view, now, t }: { view: WechatView; now: number; t: Translate }): ReactNode {
  const { binding, channel } = view
  const state = stateOf(view)
  const bound = binding.state === 'bound'
  const identity = binding.state === 'bound'
    ? [
      t('bot.id', { id: binding.botId }),
      t('bot.owner', { id: binding.ownerId }),
      binding.boundAt === null ? undefined : t('bot.since', { time: dateTime(binding.boundAt, view.timeZone) }),
    ].filter(Boolean).join(' · ')
    : undefined
  const rows: Array<[string, string]> = bound
    ? [
      [t('row.poll'), channel.lastPollAt === null ? t('poll.none') : t('poll.ok', { ago: agoText(channel.lastPollAt, now, t) })],
      [t('row.inbound'), channel.lastInboundAt === null ? t('row.none') : agoText(channel.lastInboundAt, now, t)],
      [t('row.outbound'), channel.lastOutboundAt === null
        ? t('row.none')
        : t('row.outbound.value', { ago: agoText(channel.lastOutboundAt, now, t), kind: channel.lastOutboundKind === null ? '—' : t(`kind.${channel.lastOutboundKind}`) })],
    ]
    : []
  const error = bound ? channel.lastError : null
  return (
    <section className={`${css.card} ${css.wide} ${css.hero}`} aria-label={t('bot.title')} data-state={state.tone}>
      <div className={css.identity}>
        <span className={css.avatar} aria-hidden="true">{bound ? t('bot.initial') : '–'}</span>
        <div className={css.who}>
          <div className={css.nameRow}>
            <span className={css.name}>{t('bot.title')}</span>
            <span className={css.pill} data-tone={state.tone}>{t(state.key)}</span>
          </div>
          {identity === undefined ? null : <span className={css.meta}>{identity}</span>}
          {binding.state === 'unbound' ? <span className={css.hint}>{t('unbound.hint')}</span> : null}
          {binding.state === 'invalid' ? <span className={css.reason}>{t('invalid.reason', { reason: binding.reason })}</span> : null}
        </div>
      </div>
      {rows.length === 0
        ? null
        : (
          <dl className={css.facts}>
            {rows.map(([label, value]) => (
              <div key={label} className={css.fact}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {error === null
              ? null
              : (
                <div className={`${css.fact} ${css.factError}`}>
                  <dt>{t('row.error')}</dt>
                  <dd>{`${t(error.where === 'poll' ? 'error.poll' : 'error.send', { text: error.text })} · ${agoText(error.at, now, t)}`}</dd>
                </div>
              )}
          </dl>
        )}
    </section>
  )
}

function WindowCard({ view, now, t }: { view: WechatView; now: number; t: Translate }): ReactNode {
  const { window: reply, outbox } = view
  const meta = reply.open && reply.expiresAt !== null ? t('window.expires', { span: spanText(reply.expiresAt, now, t), time: dateTime(reply.expiresAt, view.timeZone) }) : undefined
  return (
    <Card title={t('window.title')} {...meta === undefined ? {} : { meta }}>
      {reply.open && reply.repliesLeft !== null
        ? <span className={css.big}>{t('window.replies', { left: reply.repliesLeft, total: reply.repliesPerToken })}</span>
        : <span className={css.reason}>{reply.closed === null ? '' : t(`window.closed.${reply.closed}`)}</span>}
      <span className={css.hint}>{t('window.hint')}</span>
      <div className={css.queue}>
        {outbox.count === 0
          ? <span className={css.meta}>{t('outbox.empty')}</span>
          : (
            <>
              <span>{t('outbox.count', { n: outbox.count, limit: outbox.limit })}{outbox.oldestAt === null ? '' : ` · ${t('outbox.since', { ago: agoText(outbox.oldestAt, now, t) })}`}</span>
              <span className={css.hint}>{t('outbox.hint')}</span>
            </>
          )}
      </div>
    </Card>
  )
}

/** The QR code as one SVG path on a white card, so it scans in a dark theme too. */
function QrCode({ qr, t }: { qr: NonNullable<LoginSnapshot['qr']>; t: Translate }): ReactNode {
  const d = useMemo(() => qrPath(qr), [qr])
  const size = qrViewSize(qr)
  return (
    <svg className={css.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('qr.alt')} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

/** The verification number WeChat asks for. */
interface CodeFormProps {
  login: LoginSnapshot
  busy: boolean
  submit: (code: string) => void
  t: Translate
}

function CodeForm({ login, busy, submit, t }: CodeFormProps): ReactNode {
  const [draft, setDraft] = useState('')
  const id = useId()
  const value = draft.trim()
  const valid = VERIFY_CODE_PATTERN.test(value)
  return (
    <form
      className={css.codeForm}
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !busy) {
          submit(value)
          setDraft('')
        }
      }}
    >
      <label className={css.panelTitle} htmlFor={id}>{t('code.title')}</label>
      <span className={css.hint}>{login.codeRetry ? t('code.retry') : t('code.hint')}</span>
      <div className={css.actions}>
        <input
          id={id}
          className={css.input}
          value={draft}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          maxLength={8}
          placeholder={t('code.placeholder')}
          aria-invalid={value !== '' && !valid ? true : undefined}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className={css.primary} disabled={busy || !valid}>{busy ? t('code.submitting') : t('code.submit')}</button>
      </div>
    </form>
  )
}

/** The inline panel of the open or just-ended login. */
function LoginPanel({ login, busy, actions, t }: { login: LoginSnapshot; busy: ActionBusy; actions: Actions; t: Translate }): ReactNode {
  const { phase } = login
  if (phase === 'done') {
    return (
      <div className={css.panel} role="status" data-phase={phase}>
        <span className={css.panelTitle}>{t('done.title')}</span>
        <span className={css.hint}>{t('done.hint')}</span>
        <div className={css.actions}><button type="button" className={css.secondary} onClick={actions.dismissLogin}>{t('done.close')}</button></div>
      </div>
    )
  }
  if (phase === 'expired') {
    return (
      <div className={css.panel} role="status" data-phase={phase}>
        <span className={css.panelTitle}>{t('expired.title')}</span>
        <div className={css.actions}>
          <button type="button" className={css.primary} disabled={busy.login} onClick={actions.startLogin}>{busy.login ? t('bind.starting') : t('expired.retry')}</button>
          <button type="button" className={css.secondary} onClick={actions.dismissLogin}>{t('bind.cancel')}</button>
        </div>
      </div>
    )
  }
  if (phase === 'failed') {
    return (
      <div className={css.panel} role="alert" data-phase={phase}>
        <span className={css.panelTitle}>{t('failed.title')}</span>
        <span className={css.reason}>{t(`failed.${login.failure ?? 'other'}`)}</span>
        <div className={css.actions}>
          <button type="button" className={css.primary} disabled={busy.login} onClick={actions.startLogin}>{busy.login ? t('bind.starting') : t('failed.retry')}</button>
          <button type="button" className={css.secondary} onClick={actions.dismissLogin}>{t('bind.cancel')}</button>
        </div>
      </div>
    )
  }
  const link = login.qr !== null && isWeixinLink(login.qr.url) ? login.qr.url : null
  return (
    <div className={css.panel} role="status" data-phase={phase}>
      {login.qr === null ? null : <div className={css.qrFrame} data-dim={phase === 'needs-code' || phase === 'scanned' ? '' : undefined}><QrCode qr={login.qr} t={t} /></div>}
      <div className={css.panelText}>
        <span className={css.panelTitle}>{phase === 'waiting' ? t('qr.waiting') : t('qr.scanned')}</span>
        {login.qr === null ? null : <span className={css.hint}>{t('qr.attempt', { n: login.qr.attempt })}</span>}
        {link === null ? null : <a className={css.link} href={link} target="_blank" rel="noreferrer noopener">{t('qr.link')}</a>}
        {phase === 'needs-code' ? <CodeForm login={login} busy={busy.code} submit={actions.submitCode} t={t} /> : null}
        <div className={css.actions}><button type="button" className={css.secondary} onClick={actions.cancelLogin}>{t('bind.cancel')}</button></div>
      </div>
    </div>
  )
}

/** Which owner actions are in flight. */
interface ActionBusy {
  login: boolean
  code: boolean
  unbind: boolean
}

interface BindCardProps {
  view: WechatView
  login: LoginSnapshot | null
  busy: ActionBusy
  actions: Actions
  t: Translate
}

function BindCard({ view, login, busy, actions, t }: BindCardProps): ReactNode {
  const bound = view.binding.state !== 'unbound'
  return (
    <Card title={bound ? t('bind.rebind') : t('bind.title')}>
      <span className={css.hint}>{bound ? t('bind.rebindHint') : t('bind.hint')}</span>
      {login === null
        ? (
          <div className={css.actions}>
            <button type="button" className={css.primary} disabled={busy.login} onClick={actions.startLogin}>
              {busy.login ? t('bind.starting') : bound ? t('bind.restart') : t('bind.start')}
            </button>
          </div>
        )
        : <LoginPanel login={login} busy={busy} actions={actions} t={t} />}
    </Card>
  )
}

function UnbindCard({ busy, actions, t }: { busy: boolean; actions: Actions; t: Translate }): ReactNode {
  const [asking, setAsking] = useState(false)
  return (
    <Card title={t('unbind.title')}>
      <span className={css.hint}>{t('unbind.hint')}</span>
      {asking || busy
        ? (
          <div className={css.actions} role="group" aria-label={t('unbind.ask')}>
            <span className={css.warn}>{t('unbind.ask')}</span>
            <button type="button" className={css.danger} disabled={busy} onClick={() => { actions.unbind() }}>{busy ? t('unbind.confirming') : t('unbind.confirm')}</button>
            <button type="button" className={css.secondary} disabled={busy} onClick={() => { setAsking(false) }}>{t('unbind.cancel')}</button>
          </div>
        )
        : <div className={css.actions}><button type="button" className={css.secondary} onClick={() => { setAsking(true) }}>{t('unbind.start')}</button></div>}
    </Card>
  )
}

/**
 * Render the WeChat section.
 * @param props - the store hook, the callbacks, and copy.
 * @returns the section.
 */
export function WechatSection(props: WechatProps): ReactNode {
  const { useWechat, refresh, pollLogin, t, startLogin, submitCode, cancelLogin, dismissLogin, unbind } = props
  const state = useWechat(value => value)
  const translate = t as Translate
  const view = state.view
  const open = loginIsOpen(state.login)
  const loginKey = state.login?.key
  useEffect(() => startPolling(refresh, POLL_INTERVAL_MS), [refresh])
  useEffect(() => (open ? startPolling(pollLogin, LOGIN_POLL_INTERVAL_MS) : undefined), [open, loginKey, pollLogin])
  const now = Date.now()
  const actions: Actions = { startLogin, pollLogin, submitCode, cancelLogin, dismissLogin, unbind }
  const busy: ActionBusy = { login: state.busy === 'login.start', code: state.busy === 'login.code', unbind: state.busy === 'unbind' }

  let status: { tone: 'live' | 'stale' | 'idle'; text: string }
  if (view === null) status = state.stale ? { tone: 'stale', text: translate('status.failed') } : { tone: 'idle', text: translate('status.loading') }
  else if (state.stale) status = { tone: 'stale', text: translate('status.stale', { time: stampTime(state.checkedAt ?? now) }) }
  else status = { tone: 'live', text: translate('status.live', { time: stampTime(state.checkedAt ?? now) }) }

  return (
    <section className={css.section} aria-label={translate('title')} data-stale={state.stale ? '' : undefined}>
      <div className={css.header}>
        <span className={css.status} role="status">
          <span className={css.dot} data-tone={status.tone} aria-hidden="true" />
          {status.text}
        </span>
      </div>
      {state.error === null ? null : <div className={css.error} role="alert">{translate('error.action', { error: state.error })}</div>}
      {view === null
        ? null
        : (
          <div className={css.grid}>
            <StatusCard view={view} now={now} t={translate} />
            <WindowCard view={view} now={now} t={translate} />
            <BindCard view={view} login={state.login} busy={busy} actions={actions} t={translate} />
            {view.binding.state === 'bound' ? <UnbindCard busy={busy.unbind} actions={actions} t={translate} /> : null}
          </div>
        )}
    </section>
  )
}
