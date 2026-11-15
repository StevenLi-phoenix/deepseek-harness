/**
 * 浏览器接管 in the app shell: the same live frame the standalone page shows,
 * rendered by a page of the application, so the browser reaches it by clicking
 * a navigation entry instead of typing a URL below the site root. Nothing here
 * is an iframe: the frame, its input, and the control buttons speak the live
 * socket and status route directly, from the app's own origin.
 *
 * The page reads control from two places on purpose. While the live socket is
 * open it is the authority, because a control change arrives there at once;
 * while it is down, the status poll keeps the line honest. Both are the same
 * `TakeoverState` on the Host, so the buttons here and the standalone page's
 * buttons move the same state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, KeyboardEvent, PointerEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'main' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: registers this package's locale namespace for `t`.
import type {} from './locales.ts'
import type { ClientMessage, FrameMetadata } from '../input.ts'
import { STATUS_PATH } from '../paths.ts'
import {
  controlMessage, decodeServerMessage, decodeStatus, encodeClientMessage, keyMessage, liveSocketUrl,
  mouseMessage, textMessage, wheelMessage, type Holder,
} from './protocol.ts'
import css from './BrowserTakeoverPage.module.css'

/** How long the page waits before reconnecting a lost live socket. */
const RECONNECT_MS = 1_500
/** How often the page asks the status route for the URL, the viewers, and a holder while offline. */
const POLL_MS = 5_000
/** The socket's OPEN state; read numerically so the page needs no WebSocket global at mount. */
const SOCKET_OPEN = 1

/** One painted frame: what the page draws and the geometry input is scaled by. */
interface PaintedFrame {
  readonly source: string
  readonly metadata: FrameMetadata
}

/** Props the main slot hands the page. */
export type BrowserTakeoverPageProps = PropsRuntime<'main'> & PropsLocale<'headless-browser'>

/** The members of {@link BrowserTakeoverPageProps} the page reads. */
export type BrowserTakeoverViewProps = Pick<BrowserTakeoverPageProps, 't'>

/**
 * Draw the live browser, hand control between the user and the agent, and
 * forward pointer, wheel, key, and pasted input while the user holds it.
 * @param props - the slot's standard props and this namespace's translate.
 * @returns the page.
 */
export function BrowserTakeoverPage({ t }: BrowserTakeoverViewProps) {
  const [holder, setHolder] = useState<Holder>('agent')
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [viewers, setViewers] = useState(0)
  const [frame, setFrame] = useState<PaintedFrame | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [text, setText] = useState('')

  const socketRef = useRef<WebSocket | undefined>(undefined)
  const stageRef = useRef<HTMLElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  // The native wheel listener is bound once, so it reads the current holder and geometry here.
  const latest = useRef<{ holder: Holder; metadata: FrameMetadata | undefined }>({ holder: 'agent', metadata: undefined })
  useEffect(() => {
    latest.current = { holder, metadata: frame?.metadata }
  }, [holder, frame])

  const send = useCallback((message: ClientMessage): void => {
    const socket = socketRef.current
    // A dropped socket is reconnecting; a message sent now would only be lost.
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return
    socket.send(encodeClientMessage(message))
  }, [])

  useEffect(() => {
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | undefined
    const connect = (): void => {
      if (stopped) return
      socket = new WebSocket(liveSocketUrl(window.location))
      socketRef.current = socket
      socket.onopen = () => { setConnected(true) }
      socket.onmessage = (event) => {
        const message = decodeServerMessage(String(event.data))
        if (message === undefined) return
        if (message.type === 'state') {
          setHolder(message.holder)
          setReason(message.reason)
          setFailure(undefined)
        } else if (message.type === 'frame') {
          setFrame({ source: `data:image/jpeg;base64,${message.data}`, metadata: message.metadata })
          setFailure(undefined)
        } else {
          setFailure(message.message)
        }
      }
      socket.onclose = () => {
        setConnected(false)
        if (stopped) return
        retry = setTimeout(connect, RECONNECT_MS)
      }
    }
    connect()
    return () => {
      stopped = true
      if (retry !== undefined) clearTimeout(retry)
      socketRef.current = undefined
      socket?.close()
    }
  }, [])

  useEffect(() => {
    let stopped = false
    const read = async (): Promise<void> => {
      let status
      try {
        const response = await fetch(STATUS_PATH, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) return
        status = decodeStatus(await response.json())
      } catch (error: unknown) {
        // The next poll retries; a status request is not worth a visible error.
        void error
        return
      }
      if (stopped || status === undefined) return
      setUrl(status.url)
      setViewers(status.viewers)
      if (socketRef.current?.readyState !== SOCKET_OPEN) {
        setHolder(status.holder)
        setReason(status.reason)
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  // React listens for wheel on the root passively, so a page that must not scroll under the
  // pointer needs its own non-passive listener.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (event: WheelEvent): void => {
      const { holder: current, metadata } = latest.current
      const image = imageRef.current
      if (current !== 'human' || metadata === undefined || image === null) return
      const message = wheelMessage(event, image.getBoundingClientRect(), metadata)
      if (message === undefined) return
      event.preventDefault()
      send(message)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => { stage.removeEventListener('wheel', onWheel) }
  }, [send])

  const imageRect = (): DOMRect | undefined => imageRef.current?.getBoundingClientRect()

  const pointer = (kind: 'down' | 'up' | 'move') => (event: PointerEvent<HTMLElement>): void => {
    if (holder !== 'human' || frame === undefined) return
    const rect = imageRect()
    if (rect === undefined) return
    const message = mouseMessage(kind, event, rect, frame.metadata)
    if (message === undefined) return
    if (kind !== 'move') {
      event.preventDefault()
      stageRef.current?.focus()
    }
    send(message)
  }

  const onKey = (kind: 'down' | 'up') => (event: KeyboardEvent<HTMLElement>): void => {
    if (holder !== 'human') return
    const message = keyMessage(kind, event)
    if (message === undefined) return
    event.preventDefault()
    send(message)
  }

  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const pasted = event.clipboardData.getData('text')
    const message = textMessage(pasted)
    if (message === undefined) return
    event.preventDefault()
    send(message)
  }

  return (
    <div className={css.page}>
      <header className={css.header}>
        <strong className={css.title}>{t('page.title')}</strong>
        <span className={holder === 'human' ? css.badgeHuman : css.badgeAgent} aria-live="polite">
          {holder === 'human' ? t('state.human') : t('state.agent')}
        </span>
        <span className={css.hint}>{holder === 'human' ? reason ?? t('hint.human') : t('hint.agent')}</span>
        <span className={css.url} title={url}>{url ?? t('url.empty')}</span>
        {connected ? null : <span className={css.offline}>{t('connect.lost')}</span>}
        <span className={css.viewers}>{t('viewers', { count: viewers })}</span>
        <button type="button" className={css.action} hidden={holder === 'human'} onClick={() => { send(controlMessage('take', t('reason.take'))) }}>
          {t('action.take')}
        </button>
        <button type="button" className={css.action} hidden={holder !== 'human'} onClick={() => { send(controlMessage('release')) }}>
          {t('action.release')}
        </button>
      </header>
      <main
        ref={stageRef}
        className={css.stage}
        tabIndex={0}
        role="application"
        aria-label={t('stage.alt')}
        onPointerDown={pointer('down')}
        onPointerUp={pointer('up')}
        onPointerMove={pointer('move')}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
      >
        {frame === undefined
          ? <p className={css.waiting}>{failure ?? t('stage.waiting')}</p>
          : <img ref={imageRef} className={css.frame} src={frame.source} alt={t('stage.alt')} draggable={false} />}
      </main>
      <footer className={css.footer}>
        <input
          className={css.insert}
          value={text}
          placeholder={t('insert.placeholder')}
          aria-label={t('insert.placeholder')}
          autoComplete="off"
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const message = textMessage(text)
            if (message === undefined) return
            send(message)
            setText('')
            event.preventDefault()
          }}
        />
      </footer>
    </div>
  )
}
