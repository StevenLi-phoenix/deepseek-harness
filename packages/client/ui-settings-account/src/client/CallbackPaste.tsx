/** Callback paste for sign-in from a page the browser callback cannot reach, such as a tailnet or proxy domain. */
import { useState } from 'react'
import { Button, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountKey } from './locales.ts'
import css from './CallbackPaste.module.css'

/** Query shown after the callback prefix in the empty field; protocol syntax, not translated copy. */
const CALLBACK_QUERY = '?code=…'

/**
 * @param props - address prefix the browser stops on, the completion action, and localized copy.
 * @returns prompt, address field, and submit button; a rejected address keeps the field for another try.
 */
export function CallbackPaste({ prefix, submit, t }: {
  /** Loopback callback address without its query, as sent to Platform. */
  prefix: string
  /** @param url - pasted address. @returns after the sign-in completes; rejects when the Host refuses the address. */
  submit: (url: string) => Promise<void>
  t: (key: AccountKey) => string
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const send = async () => {
    setBusy(true)
    setFailed(false)
    try { await submit(value) } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <div className={css.paste}>
    <p className={css.prompt}>{t('pastePrompt')}<code className={css.prefix}>{prefix}</code>{t('pastePromptEnd')}</p>
    <div className={css.row}>
      <input className={css.input} type="text" aria-label={t('pasteLabel')} placeholder={prefix + CALLBACK_QUERY}
        value={value} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={busy}
        onChange={(event) => { setValue(event.target.value); setFailed(false) }}
        onKeyDown={(event) => { if (event.key === 'Enter' && value.trim() !== '' && !busy) void send() }} />
      <Button variant="primary" className={css.submit} disabled={busy || value.trim() === ''}
        aria-label={busy ? t('waiting') : undefined} onClick={() => { void send() }}>
        {busy ? <IconLoadingOutlineRegular className={css.spinner} /> : t('pasteSubmit')}
      </Button>
    </div>
    {failed && <p className={css.error} role="alert">{t('pasteFailed')}</p>}
  </div>
}
