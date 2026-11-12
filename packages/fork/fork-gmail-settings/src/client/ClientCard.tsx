/**
 * The Google OAuth client. Configured, it is a collapsed card with the client id, whether the secret is stored (never
 * the secret), and the redirect URI, plus 更换客户端. Not configured, it lists the Google Cloud steps with the redirect
 * URI to copy, the home page and privacy statement to enter, and a box for the downloaded JSON. The box holds the
 * client secret: it asks the browser for no autofill, spelling, or writing-assistant help, and empties after a
 * successful save.
 */

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { appPagesOf, parsesAsJson, redirectAccepted, redirectUriOf, type Translate } from './gmail.ts'
import type { GmailKey } from './locales.ts'
import { ActionError, Field, type PartProps } from './parts.tsx'
import css from './GmailSection.module.css'

/** Writes text to the clipboard; rejects where the browser withholds it. */
type Copy = (text: string) => Promise<void>

/** What both faces of the card receive. */
interface FaceProps {
  readonly parts: PartProps
  /** The redirect URI to register at Google. */
  readonly uri: string
  /** This page's origin. */
  readonly origin: string
  readonly copy: Copy
}

/** The steps done on a Google Cloud page, with that page. */
const CONSOLE_STEPS: ReadonlyArray<{ readonly key: GmailKey; readonly href: string }> = [
  { key: 'client.stepProject', href: 'https://console.cloud.google.com/projectselector2/home/dashboard' },
  { key: 'client.stepApi', href: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com' },
  { key: 'client.stepConsent', href: 'https://console.cloud.google.com/auth/overview' },
  { key: 'client.stepBranding', href: 'https://console.cloud.google.com/auth/branding' },
  { key: 'client.stepCredentials', href: 'https://console.cloud.google.com/auth/clients/create' },
]

/** The redirect URI in a read-only field with a copy button; without clipboard access the field is selected instead. */
function RedirectField({ uri, copy, t }: { uri: string; copy: Copy; t: Translate }): ReactNode {
  const field = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  return (
    <div className={css.redirect}>
      <div className={css.copyRow}>
        <input ref={field} className={css.mono} readOnly value={uri} aria-label={t('client.redirect')} onFocus={(event) => { event.target.select() }} />
        <button
          type="button"
          className={css.secondary}
          onClick={() => {
            void copy(uri).then(
              () => { setCopied('ok') },
              () => {
                // The clipboard needs a secure context, which a plain-http page lacks.
                field.current?.focus()
                setCopied('failed')
              },
            )
          }}
        >
          {copied === 'ok' ? t('client.copied') : t('client.copy')}
        </button>
      </div>
      {copied === 'failed' ? <span className={css.hint} role="status">{t('client.copyFailed')}</span> : null}
      {redirectAccepted(uri) ? null : <span className={css.warnText}>{t('client.redirectRefused')}</span>}
    </div>
  )
}

/** The box for the client JSON and its save button. */
function ClientForm({ parts, onSaved }: { parts: PartProps; onSaved?: (() => void) | undefined }): ReactNode {
  const { busy, failure, t, act } = parts
  const [json, setJson] = useState('')
  const [invalid, setInvalid] = useState(false)
  const fieldId = useId()
  const hintId = useId()
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = json.trim()
    if (!parsesAsJson(text)) {
      setInvalid(true)
      return
    }
    void act({ action: 'client', json: text }).then((saved) => {
      if (!saved) return
      setJson('')
      onSaved?.()
    })
  }
  return (
    <form className={css.form} onSubmit={submit} noValidate>
      <div className={css.control}>
        <label className={css.label} htmlFor={fieldId}>{t('client.json')}</label>
        <textarea
          id={fieldId}
          className={css.textarea}
          rows={6}
          value={json}
          placeholder={t('client.jsonPlaceholder')}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          aria-invalid={invalid}
          aria-describedby={hintId}
          disabled={busy !== null}
          onChange={(event) => {
            setJson(event.target.value)
            setInvalid(false)
          }}
        />
        <span id={hintId} className={invalid ? css.fieldError : css.hint}>{invalid ? t('client.jsonInvalid') : t('client.jsonHint')}</span>
      </div>
      <div className={css.actions}>
        <button type="submit" className={css.primary} disabled={busy !== null || json.trim() === ''} aria-busy={busy === 'client' ? true : undefined}>
          {busy === 'client' ? t('client.saving') : t('client.save')}
        </button>
      </div>
      <ActionError failure={failure} controls={['client']} t={t} />
    </form>
  )
}

function ConfiguredClient({ parts, uri, copy }: FaceProps): ReactNode {
  const { view, t } = parts
  const [replacing, setReplacing] = useState(false)
  return (
    <details className={css.card}>
      <summary className={css.summary}>
        <span className={css.cardTitle}>{t('client.title')}</span>
        <span className={css.meta}>{t('client.configured')}</span>
      </summary>
      <dl className={css.fields}>
        <Field label={t('client.id')}><span className={css.monoText}>{view.client.clientId ?? ''}</span></Field>
        <Field label={t('client.secret')}>
          {view.client.secretConfigured ? t('client.secretStored') : <span className={css.warnText}>{t('client.secretMissing')}</span>}
        </Field>
        <Field label={t('client.redirect')}><RedirectField uri={uri} copy={copy} t={t} /></Field>
      </dl>
      {replacing
        ? (
          <>
            <ClientForm parts={parts} onSaved={() => { setReplacing(false) }} />
            <div className={css.actions}>
              <button type="button" className={css.secondary} disabled={parts.busy === 'client'} onClick={() => { setReplacing(false) }}>
                {t('client.replaceCancel')}
              </button>
            </div>
          </>
        )
        : (
          <div className={css.actions}>
            <button type="button" className={css.secondary} onClick={() => { setReplacing(true) }}>{t('client.replace')}</button>
          </div>
        )}
    </details>
  )
}

function ClientSetup({ parts, uri, origin, copy }: FaceProps): ReactNode {
  const { t } = parts
  const titleId = useId()
  const pages = appPagesOf(uri, origin)
  return (
    <section className={css.card} aria-labelledby={titleId} data-tone="setup">
      <span id={titleId} className={css.cardTitle}>{t('client.title')}</span>
      <p className={css.hint}>{t('client.intro')}</p>
      <ol className={css.steps}>
        {CONSOLE_STEPS.map(step => (
          <li key={step.key}>
            {t(step.key, pages)}
            {' '}
            <a className={css.link} href={step.href} target="_blank" rel="noreferrer">{t('client.open')}</a>
          </li>
        ))}
        <li>
          {t('client.stepRedirect')}
          <RedirectField uri={uri} copy={copy} t={t} />
        </li>
        <li>{t('client.stepDownload')}</li>
      </ol>
      <ClientForm parts={parts} />
    </section>
  )
}

/**
 * The OAuth client card.
 * @param props - the section's parts, this page's origin for the default redirect URI, and the clipboard write.
 * @returns the card.
 */
export function ClientCard({ parts, origin, copy }: { parts: PartProps; origin: string; copy: Copy }): ReactNode {
  const uri = redirectUriOf(parts.view, origin)
  return parts.view.client.configured
    ? <ConfiguredClient parts={parts} uri={uri} origin={origin} copy={copy} />
    : <ClientSetup parts={parts} uri={uri} origin={origin} copy={copy} />
}
