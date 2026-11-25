/**
 * 浏览器接管 in the app shell: a real browser view over the live socket, not a
 * video. The tab strip, address bar, and back/forward/reload buttons are the
 * browser chrome; the viewport paints only the active tab's WebSocket frames
 * and forwards pointer, wheel, key, and text input to the active tab. No HTTP
 * route supplies pixels and no iframe or sub-URL is opened: a dropped socket
 * shows a reconnect line, never an error page.
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
import type { ClientMessage, FrameMetadata, TabAction, TabInfo } from '../input.ts'
import { STATUS_ROUTE } from '../paths.ts'
import {
  controlMessage, decodeServerMessage, decodeStatus, encodeClientMessage, keyMessage, liveSocketUrl,
  mouseMessage, normalizeAddress, tabMessage, textMessage, wheelMessage, type Holder,
} from './protocol.ts'
import css from './BrowserTakeoverPage.module.css'

/** How long the page waits before reconnecting a lost live socket. */
const RECONNECT_MS = 1_500
/** How often the page asks the status route for the URL, the viewers, and a holder while offline. */
const POLL_MS = 5_000
/** The socket's OPEN state; read numerically so the page needs no WebSocket global at mount. */
const SOCKET_OPEN = 1
/** Two clicks within this window make the second a double-click in the page. */
const DOUBLE_CLICK_MS = 400

/** One painted frame: what the page draws and the geometry input is scaled by. */
interface PaintedFrame {
  readonly tabId?: string
  readonly source: string
  readonly metadata: FrameMetadata
}

/** Props the main slot hands the page. */
export type BrowserTakeoverPageProps = PropsRuntime<'main'> & PropsLocale<'headless-browser'>

/** The members of {@link BrowserTakeoverPageProps} the page reads. */
export type BrowserTakeoverViewProps = Pick<BrowserTakeoverPageProps, 't'>

/**
 * Draw the live browser, move between its tabs, and forward input while the
 * user holds it.
 * @param props - the slot's standard props and this namespace's translate.
 * @returns the page.
 */
export function BrowserTakeoverPage({ t }: BrowserTakeoverViewProps) {
  const [holder, setHolder] = useState<Holder>('agent')
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [tabs, setTabs] = useState<readonly TabInfo[]>([])
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [viewers, setViewers] = useState(0)
  const [frame, setFrame] = useState<PaintedFrame | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [address, setAddress] = useState('')
  const [editingAddress, setEditingAddress] = useState(false)
  const [text, setText] = useState('')

  const socketRef = useRef<WebSocket | undefined>(undefined)
  const stageRef = useRef<HTMLElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const activeIdRef = useRef<string | undefined>(undefined)
  const clickRef = useRef<{ at: number; count: number }>({ at: 0, count: 0 })
  const committedAddress = useRef(false)
  // The native wheel listener is bound once, so it reads the current holder and geometry here.
  const latest = useRef<{ holder: Holder; tabId: string | undefined; metadata: FrameMetadata | undefined }>({
    holder: 'agent', tabId: undefined, metadata: undefined,
  })

  const activeTab = tabs.find(tab => tab.active)
  const activeId = activeTab?.id
  const activeUrl = activeTab?.url === undefined || activeTab.url === '' ? url : activeTab.url
  useEffect(() => {
    latest.current = { holder, tabId: activeId, metadata: frame?.metadata }
  }, [holder, activeId, frame])

  // A tab switch paints the new tab's frame, never the old tab's last picture.
  useEffect(() => {
    if (activeIdRef.current === activeId) return
    activeIdRef.current = activeId
    setFrame(undefined)
  }, [activeId])

  // The address bar follows the active tab unless the owner is editing it.
  useEffect(() => {
    if (!editingAddress) setAddress(activeUrl ?? '')
  }, [activeUrl, editingAddress])

  const send = useCallback((message: ClientMessage): void => {
    const socket = socketRef.current
    // A dropped socket is reconnecting; a message sent now would only be lost.
    if (socket === undefined || socket.readyState !== SOCKET_OPEN) return
    socket.send(encodeClientMessage(message))
  }, [])

  const sendTab = useCallback((action: TabAction, tabId?: string, target?: string): void => {
    send(tabMessage(action, tabId, target))
  }, [send])

  useEffect(() => {
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | undefined
    const connect = (): void => {
      if (stopped) return
      socket = new WebSocket(liveSocketUrl(window.location))
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        setFailure(undefined)
      }
      socket.onmessage = (event) => {
        const message = decodeServerMessage(String(event.data))
        if (message === undefined) return
        if (message.type === 'state') {
          setTabs(message.tabs)
          setHolder(message.holder)
          setReason(message.reason)
          setFailure(undefined)
        } else if (message.type === 'frame') {
          // Only pixels for the active tab may reach the viewport; a late frame
          // from a tab the owner just left is dropped, not painted.
          if (message.tabId !== undefined && activeIdRef.current !== undefined && message.tabId !== activeIdRef.current) return
          setFrame({
            ...message.tabId === undefined ? {} : { tabId: message.tabId },
            source: `data:image/jpeg;base64,${message.data}`,
            metadata: message.metadata,
          })
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
        const response = await fetch(STATUS_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
        // A 401 here is a status read, not a picture: the viewport never renders
        // its body, and the socket's reconnect line is the only connection state.
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
    const onWheel = (event: globalThis.WheelEvent): void => {
      const { holder: current, tabId, metadata } = latest.current
      const image = imageRef.current
      if (current !== 'human' || metadata === undefined || image === null) return
      const message = wheelMessage(event, image.getBoundingClientRect(), metadata)
      if (message === undefined) return
      event.preventDefault()
      send({ ...message, ...tabId === undefined ? {} : { tabId } })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => { stage.removeEventListener('wheel', onWheel) }
  }, [send])

  const imageRect = (): DOMRect | undefined => imageRef.current?.getBoundingClientRect()

  const pointer = (kind: 'down' | 'up' | 'move') => (event: PointerEvent<HTMLElement>): void => {
    if (kind === 'down') stageRef.current?.focus()
    if (holder !== 'human' || frame === undefined) return
    const rect = imageRect()
    if (rect === undefined) return
    const message = mouseMessage(kind, event, rect, frame.metadata)
    if (message === undefined) return
    if (kind === 'down') {
      const now = Date.now()
      const prior = clickRef.current
      const count = event.button === 0 && now - prior.at < DOUBLE_CLICK_MS ? Math.min(3, prior.count + 1) : 1
      clickRef.current = { at: now, count }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      event.preventDefault()
      send({ ...message, clickCount: count, ...frame.tabId === undefined ? {} : { tabId: frame.tabId } })
      return
    }
    if (kind === 'up') {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      event.preventDefault()
    }
    send({ ...message, ...frame.tabId === undefined ? {} : { tabId: frame.tabId } })
  }

  const onKey = (kind: 'down' | 'up') => (event: KeyboardEvent<HTMLElement>): void => {
    if (holder !== 'human' || event.nativeEvent.isComposing) return
    const message = keyMessage(kind, event)
    if (message === undefined) return
    // The viewport owns these keys while it is focused: no app shortcut may
    // consume them before the browser does. Stopping the native event as well
    // keeps a window-level listener from seeing it after React's root handler.
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation()
    send({ ...message, ...activeId === undefined ? {} : { tabId: activeId } })
  }

  const onPaste = (event: ClipboardEvent<HTMLElement>): void => {
    const pasted = event.clipboardData.getData('text')
    const message = textMessage(pasted)
    if (message === undefined) return
    event.preventDefault()
    send({ ...message, ...activeId === undefined ? {} : { tabId: activeId } })
  }

  const commitAddress = (): void => {
    const target = normalizeAddress(address)
    if (target === undefined) return
    if (activeId === undefined) sendTab('new', undefined, target)
    else sendTab('navigate', activeId, target)
    committedAddress.current = true
    setEditingAddress(false)
    setAddress(target)
  }

  return (
    <div className={css.page}>
      <header className={css.header}>
        <strong className={css.title}>{t('page.title')}</strong>
        <span className={holder === 'human' ? css.badgeHuman : css.badgeAgent} aria-live="polite">
          {holder === 'human' ? t('state.human') : t('state.agent')}
        </span>
        <span className={css.hint}>{holder === 'human' ? reason ?? t('hint.human') : t('hint.agent')}</span>
        {connected ? null : <span className={css.offline} role="status">{t('connect.lost')}</span>}
        <span className={css.viewers}>{t('viewers', { count: viewers })}</span>
        <button type="button" className={css.action} hidden={holder === 'human'} onClick={() => { send(controlMessage('take', t('reason.take'))) }}>
          {t('action.take')}
        </button>
        <button type="button" className={css.action} hidden={holder !== 'human'} onClick={() => { send(controlMessage('release')) }}>
          {t('action.release')}
        </button>
      </header>

      <nav className={css.tabStrip} aria-label={t('page.title')}>
        {tabs.map(tab => (
          <div key={tab.id} className={tab.active ? css.tabActive : css.tab}>
            <button
              type="button"
              className={css.tabTitle}
              disabled={holder !== 'human'}
              aria-current={tab.active ? 'page' : undefined}
              title={tab.title === '' ? t('tab.untitled') : tab.title}
              onClick={() => { sendTab('activate', tab.id) }}
            >
              {tab.loading ? <span className={css.spinner} aria-label={t('nav.reload')} /> : null}
              <span className={css.tabLabel}>{tab.title === '' ? t('tab.untitled') : tab.title}</span>
            </button>
            <button
              type="button"
              className={css.tabClose}
              disabled={holder !== 'human'}
              aria-label={t('tab.close')}
              onClick={(event) => {
                event.stopPropagation()
                sendTab('close', tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button type="button" className={css.tabNew} disabled={holder !== 'human'} aria-label={t('tab.new')} onClick={() => { sendTab('new') }}>
          +
        </button>
      </nav>

      <div className={css.toolbar}>
        <button type="button" className={css.tool} disabled={holder !== 'human'} aria-label={t('nav.back')} onClick={() => { sendTab('back', activeId) }}>
          <span aria-hidden="true">←</span>
        </button>
        <button type="button" className={css.tool} disabled={holder !== 'human'} aria-label={t('nav.forward')} onClick={() => { sendTab('forward', activeId) }}>
          <span aria-hidden="true">→</span>
        </button>
        <button type="button" className={css.tool} disabled={holder !== 'human'} aria-label={t('nav.reload')} onClick={() => { sendTab('reload', activeId) }}>
          <span aria-hidden="true">⟳</span>
        </button>
        <input
          className={css.address}
          value={address}
          disabled={holder !== 'human'}
          placeholder={t('address.placeholder')}
          aria-label={t('address.label')}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => {
            committedAddress.current = false
            setEditingAddress(true)
            event.currentTarget.select()
          }}
          onChange={(event) => { setAddress(event.target.value) }}
          onBlur={() => {
            setEditingAddress(false)
            // An Enter already put the typed target in the bar; only an
            // abandoned edit reverts to the active tab's URL.
            if (committedAddress.current) {
              committedAddress.current = false
              return
            }
            setAddress(activeUrl ?? '')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitAddress()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setEditingAddress(false)
              setAddress(activeUrl ?? '')
              event.currentTarget.blur()
            }
          }}
        />
        {activeTab?.loading === true ? <span className={css.loading}>{t('nav.reload')}</span> : null}
      </div>

      <main
        ref={stageRef}
        className={css.stage}
        tabIndex={0}
        role="application"
        aria-label={t('stage.alt')}
        onPointerDown={pointer('down')}
        onPointerUp={pointer('up')}
        onPointerMove={pointer('move')}
        onPointerCancel={pointer('up')}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
        onContextMenu={(event) => { event.preventDefault() }}
      >
        {frame === undefined
          ? <p className={css.waiting}>{failure ?? t('stage.waiting')}</p>
          : (
            <img
              ref={imageRef}
              className={css.frame}
              src={frame.source}
              alt={t('stage.alt')}
              draggable={false}
              style={{ aspectRatio: `${String(frame.metadata.deviceWidth)} / ${String(frame.metadata.deviceHeight)}` }}
            />
          )}
        {frame !== undefined && failure !== undefined ? <p className={css.notice}>{failure}</p> : null}
      </main>

      <footer className={css.footer}>
        <input
          className={css.insert}
          value={text}
          disabled={holder !== 'human'}
          placeholder={t('insert.placeholder')}
          aria-label={t('insert.placeholder')}
          autoComplete="off"
          onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            const message = textMessage(text)
            if (message === undefined) return
            send({ ...message, ...activeId === undefined ? {} : { tabId: activeId } })
            setText('')
            event.preventDefault()
          }}
        />
      </footer>
    </div>
  )
}
