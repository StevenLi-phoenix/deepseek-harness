// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentsView } from '../src/views.ts'
import { AgentsSection, ASR_PATCH, type AgentsProps, type PreviewOutcome } from '../src/client/Agents.tsx'
import { zh } from '../src/client/locales.ts'
import { createResourceStore, type ResourceState } from '../src/client/resource.ts'

const t = makeTranslate(zh) as AgentsProps['t']
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime()

const VIEW: AgentsView = {
  checkedAt: NOW,
  cc: {
    enabled: true,
    login: 'token',
    maxSessions: 3,
    started: ['review-1'],
    sessions: [
      { name: 'review-1', pid: 111, status: 'idle', cwd: '/Users/dsh-runtime/work/cc', updatedAt: NOW - 120_000, managed: true },
      { name: 'manual', pid: 222, status: 'busy', cwd: null, updatedAt: null, managed: false },
    ],
  },
  voice: {
    available: true, ttsEnabled: true, provider: 'feiyu', format: 'mp3', ttsUp: true, asrEnabled: false, engine: 'funasr', asrUp: null, previewChars: 20,
  },
}

function mount(
  state: Partial<ResourceState<AgentsView>> = { data: VIEW, checkedAt: NOW },
  options: { act?: (request: unknown) => Promise<boolean>; preview?: (onPlaying: () => void) => Promise<PreviewOutcome> } = {},
) {
  const store = createResourceStore<AgentsView>()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const send = vi.fn(options.act ?? (() => Promise.resolve(true)))
  const dismiss = vi.fn()
  const preview = vi.fn(options.preview ?? (() => Promise.resolve({ ok: true } as const)))
  const stopPreview = vi.fn()
  const props = {
    close: () => {}, useAgents: bindSnapshotSelector(store), refresh, act: send, dismiss, preview, stopPreview, t,
  } as AgentsProps
  const view = render(<AgentsSection {...props} />)
  return { store, refresh, act: send, dismiss, preview, stopPreview, view }
}

const button = (name: string): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name })
const input = (label: RegExp): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(label)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Claude Code card', () => {
  it('polls while open and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view } = mount({})
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows the login state and the live sessions, and a stop button only for the ones it started', () => {
    mount()
    expect(screen.getByText('只有推理 token：能跑任务，Remote Control 需要完整登录')).toBeTruthy()
    const managed = document.querySelector('[data-session="review-1"]')!
    expect(managed.textContent).toContain('pid 111 · 状态 idle · 2 分钟前 · /Users/dsh-runtime/work/cc')
    expect(within(managed as HTMLElement).getByRole('button', { name: '停止' })).toBeTruthy()
    const external = document.querySelector('[data-session="manual"]')!
    expect(external.textContent).toContain('不是从这里启动的，无法在此停止')
    expect(within(external as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('asks before stopping', () => {
    const { act: send } = mount()
    const row = document.querySelector('[data-session="review-1"]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '停止' }))
    expect(send).not.toHaveBeenCalled()
    expect(within(row).getByRole('alertdialog').textContent).toContain('停止会话“review-1”？进行中的工作会丢失。')
    fireEvent.click(within(row).getByRole('button', { name: '取消' }))
    expect(send).not.toHaveBeenCalled()
    fireEvent.click(within(row).getByRole('button', { name: '停止' }))
    fireEvent.click(within(row).getAllByRole('button', { name: '停止' })[0]!)
    expect(send).toHaveBeenCalledWith({ action: 'cc.stop', name: 'review-1' })
  })

  it('starts a session with a name and a first task, and clears the form when it is accepted', async () => {
    const { act: send } = mount()
    fireEvent.change(screen.getByLabelText(/名称（/u), { target: { value: 'research-2' } })
    fireEvent.change(screen.getByLabelText(/第一条任务/u), { target: { value: ' read the logs ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '启动会话' })) })
    expect(send).toHaveBeenCalledWith({ action: 'cc.start', name: 'research-2', task: 'read the logs' })
    expect(input(/名称（/u).value).toBe('')
  })

  it('leaves the task out when blank, validates the name and the task length first, and shows the limit', async () => {
    const { act: send } = mount()
    expect(screen.getByText('最多同时运行 3 个；已启动 1 个。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '启动会话' }))
    expect(screen.getByRole('alert').textContent).toBe('名称要用小写字母、数字或连字符，最长 31 个字符。')
    expect(send).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/名称（/u), { target: { value: 'ok-name' } })
    fireEvent.change(screen.getByLabelText(/第一条任务/u), { target: { value: 'a'.repeat(8001) } })
    fireEvent.click(screen.getByRole('button', { name: '启动会话' }))
    expect(screen.getByRole('alert').textContent).toBe('任务最多 8000 字。')
    fireEvent.change(screen.getByLabelText(/第一条任务/u), { target: { value: '' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '启动会话' })) })
    expect(send).toHaveBeenCalledWith({ action: 'cc.start', name: 'ok-name' })
  })

  it('disables start at the session limit and while a start is in flight', () => {
    mount({ data: { ...VIEW, cc: { ...VIEW.cc!, started: ['a', 'b', 'c'] } }, checkedAt: NOW })
    expect(button('启动会话').disabled).toBe(true)
    cleanup()
    mount({ data: VIEW, checkedAt: NOW, busy: { 'cc.start:x': true } })
    expect(button('正在启动…').disabled).toBe(true)
  })

  it('says so when the bridge is off or the service account is not signed in', () => {
    mount({ data: { ...VIEW, cc: null }, checkedAt: NOW })
    expect(screen.getByText('Claude Code 桥已关闭。')).toBeTruthy()
    cleanup()
    mount({ data: { ...VIEW, cc: { ...VIEW.cc!, login: 'none' } }, checkedAt: NOW })
    expect(screen.getByText('没有登录：会话起不来。按 RUNBOOK 第 14 节登录。')).toBeTruthy()
  })
})

describe('voice card', () => {
  it('shows speech and transcription state, and the patch that turns transcription on', () => {
    mount()
    expect(screen.getByText('feiyu · mp3')).toBeTruthy()
    expect(screen.getByText('可达')).toBeTruthy()
    expect(screen.getByText(/听写由配置决定，这里只读/u)).toBeTruthy()
    expect(document.querySelector('code')!.textContent).toBe(ASR_PATCH)
    expect(ASR_PATCH).toBe('- id: voice\n  config: { asr: { enabled: true } }')
  })

  it('drops the patch hint once transcription is on and marks a down service', () => {
    mount({ data: { ...VIEW, voice: { ...VIEW.voice!, asrEnabled: true, engine: 'whisper', asrUp: false, ttsUp: false } }, checkedAt: NOW })
    expect(document.querySelector('code')).toBeNull()
    expect(screen.getAllByText('无响应')).toHaveLength(2)
    expect(screen.getByText('whisper')).toBeTruthy()
  })

  it('previews: shows synthesizing, then playing, then ready again, and says the audio goes nowhere else', async () => {
    let playing: () => void = () => {}
    let finish: (outcome: PreviewOutcome) => void = () => {}
    const { preview } = mount(undefined, { preview: onPlaying => new Promise((resolve) => { playing = onPlaying; finish = resolve }) })
    expect(screen.getByText(/不会发到微信/u).textContent).toContain('20 字')
    fireEvent.click(screen.getByRole('button', { name: '试听' }))
    expect(preview).toHaveBeenCalledTimes(1)
    expect(button('合成中…').disabled).toBe(true)
    act(() => { playing() })
    expect(button('正在播放…').disabled).toBe(true)
    await act(async () => { finish({ ok: true }) })
    expect(button('试听').disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows why a preview failed and lets it be tried again', async () => {
    const { preview } = mount(undefined, { preview: () => Promise.resolve({ ok: false, code: 'speech_failed', detail: 'feiyu timed out' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '试听' })) })
    expect(screen.getByRole('alert').textContent).toBe('语音服务没有合成出声音。 (feiyu timed out)')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '试听' })) })
    expect(preview).toHaveBeenCalledTimes(2)
  })

  it('cannot preview while speech is off, stops a playing preview when closed, and explains a missing service', () => {
    const { view, stopPreview } = mount({ data: { ...VIEW, voice: { ...VIEW.voice!, ttsEnabled: false } }, checkedAt: NOW })
    expect(button('试听').disabled).toBe(true)
    view.unmount()
    expect(stopPreview).toHaveBeenCalled()
    mount({ data: { ...VIEW, voice: null }, checkedAt: NOW })
    expect(screen.getByText('语音服务没有加载。')).toBeTruthy()
  })
})

describe('notices and staleness', () => {
  it('shows a refused action and dismisses it', () => {
    const { dismiss } = mount({ data: VIEW, checkedAt: NOW, notice: { kind: 'error', code: 'limit_reached' } })
    expect(screen.getByRole('alert').textContent).toContain('已达上限')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(dismiss).toHaveBeenCalled()
  })

  it('keeps the last reading with a quiet stale line', () => {
    mount({ data: VIEW, checkedAt: NOW, stale: true })
    expect(screen.getByRole('status').textContent).toBe('未能刷新 · 显示 12:00:00 的数据')
  })
})

describe('Claude Code card corners', () => {
  it('leaves a missing status and an unknown start time out of the line, and shows a stop in flight as busy', () => {
    const cc = { ...VIEW.cc!, sessions: [{ name: 'quiet', pid: 5, status: null, cwd: null, updatedAt: null, managed: true }] }
    mount({ data: { ...VIEW, cc }, checkedAt: NOW, busy: { 'cc.stop:quiet': true } })
    const row = document.querySelector<HTMLElement>('[data-session="quiet"]')!
    expect(within(row).getByText('pid 5')).toBeTruthy()
    expect(row.hasAttribute('data-busy')).toBe(true)
    expect(within(row).getByRole('button', { name: '停止' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows a full login in green and says so when no session runs', () => {
    mount({ data: { ...VIEW, cc: { ...VIEW.cc!, login: 'full', sessions: [], started: [] } }, checkedAt: NOW })
    expect(document.querySelector('[data-tone="ok"]')).not.toBeNull()
    expect(screen.getByText(zh['agents.cc.empty'])).toBeTruthy()
  })

  it('keeps what was typed when the Host refuses the start', async () => {
    mount(undefined, { act: () => Promise.resolve(false) })
    fireEvent.change(screen.getByLabelText(/名称（/u), { target: { value: 'research-2' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '启动会话' })) })
    expect(input(/名称（/u).value).toBe('research-2')
  })
})

describe('voice and notices corners', () => {
  it('shows a failed preview without a reason as the bare message', async () => {
    mount(undefined, { preview: () => Promise.resolve({ ok: false, code: 'network' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '试听' })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.network'])
  })

  it('shows a refused action with its reason, and says the reading failed when the Host never answered with data', () => {
    mount({ data: VIEW, checkedAt: NOW, notice: { kind: 'error', code: 'start_failed', detail: 'tmux missing' } })
    expect(screen.getByRole('alert').textContent).toContain('(tmux missing)')
    cleanup()
    mount({ data: null, checkedAt: NOW })
    expect(screen.getByRole('status').textContent).toBe(zh['status.failed'])
  })

  it('shows data that carries no reading time with the time at zero', () => {
    mount({ data: VIEW, checkedAt: null })
    expect(screen.getByRole('status').textContent).toBe(zh['status.loading'])
    expect(document.querySelector('[data-session="review-1"]')!.textContent).toContain('pid 111')
  })
})
