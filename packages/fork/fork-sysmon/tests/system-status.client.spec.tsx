// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SysmonSnapshot } from '../src/snapshot.ts'
import { createSysmonStore, type SysmonState } from '../src/client/sysmon.ts'
import { SystemStatusSection, type SystemStatusProps } from '../src/client/SystemStatus.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as SystemStatusProps['t']
const GiB = 1024 ** 3

const SNAPSHOT: SysmonSnapshot = {
  sampledAt: new Date(2026, 9, 23, 6, 5, 9).getTime(),
  uptime: 90_061,
  cpu: { usage: 0.64, cores: 10, load: [2.5, 1.875, 1.2] },
  memory: { total: 16 * GiB, used: 10.8 * GiB, swapTotal: 2 * GiB, swapUsed: 0.7 * GiB, approximate: false },
  power: { system: 7.78, cpu: 2.16, gpu: 0.06, ane: 0 },
  temperature: { cpu: 49.6, gpu: 44.8 },
  disks: [
    { mount: '/System/Volumes/Data', label: 'Internal', total: 228 * GiB, used: 209 * GiB, free: 19 * GiB },
    { mount: '/Volumes/MiniSSD', label: 'MiniSSD', total: 3600 * GiB, used: 3500 * GiB, free: 100 * GiB },
  ],
  skippedMounts: [],
  sources: { macmon: 'ok' },
}

function mount(state: Partial<SysmonState>) {
  const store = createSysmonStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  // The shell's global standard hooks are not read by this section.
  const props = { close: () => {}, useSysmon: bindSnapshotSelector(store), refresh, t } as SystemStatusProps
  const element = () => <SystemStatusSection {...props} />
  const view = render(element())
  return { store, refresh, view, rerender: () => { view.rerender(element()) } }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SystemStatusSection', () => {
  it('reads on opening, every 5 s while open, and stops when closed', () => {
    vi.useFakeTimers()
    const { refresh, view, store, rerender } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
    // A store update re-renders without restarting the poller.
    act(() => { store.update((draft) => { draft.snapshot = SNAPSHOT }) })
    rerender()
    expect(refresh).toHaveBeenCalledTimes(2)
    view.unmount()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('shows CPU, Memory, Power, and one bar per volume', () => {
    mount({ snapshot: SNAPSHOT, checkedAt: 1 })
    expect(screen.getByRole('status').textContent).toBe('06:05:09 更新')
    expect(screen.getByText('已运行 1 天 1 小时')).toBeTruthy()
    const cpu = screen.getByRole('region', { name: 'CPU' })
    expect(cpu.textContent).toContain('10 核')
    expect(cpu.textContent).toContain('64%')
    expect(screen.getByRole('region', { name: '内存' }).textContent).toContain('10.8 GB/ 16 GB')
    const power = screen.getByRole('region', { name: '功耗' })
    expect(power.textContent).toContain('7.8 W')
    expect(power.textContent).toContain('CPU 2.2 W · GPU 0.1 W · ANE 0 W')
    expect(power.textContent).toContain('CPU 50 °C · GPU 45 °C')
    const meters = screen.getAllByRole('meter')
    expect(meters.map(meter => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow')]))
      .toEqual([['CPU', '64'], ['内存', '68'], ['Internal', '92'], ['MiniSSD', '97']])
    expect(meters[2]!.firstElementChild!.className).toMatch(/warn/)
    expect(meters[3]!.firstElementChild!.className).toMatch(/critical/)
    expect(document.querySelector('[data-mount="/Volumes/MiniSSD"]')!.textContent).toContain('剩余 100 GB')
  })

  it('tells how to install macmon instead of showing zero watts', () => {
    mount({ snapshot: { ...SNAPSHOT, power: null, temperature: null, sources: { macmon: 'missing' } }, checkedAt: 1 })
    const power = screen.getByRole('region', { name: '功耗' })
    expect(power.textContent).toContain('安装 macmon 后显示功耗与温度：')
    expect(power.querySelector('code')!.textContent).toBe('brew install macmon')
    expect(power.textContent).not.toContain(' W')
  })

  it('keeps the last reading with a quiet stale line, and lists a volume it could not read', () => {
    const { view } = mount({
      snapshot: { ...SNAPSHOT, skippedMounts: [{ mount: '/Volumes/Backup', label: 'Backup', reason: 'not found' }] }, checkedAt: 2, stale: true,
    })
    expect(screen.getByRole('status').textContent).toBe('未能刷新 · 显示 06:05:09 的数据')
    expect(view.container.querySelector('[data-stale]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'CPU' }).textContent).toContain('64%')
    expect(document.querySelector('[data-mount="/Volumes/Backup"]')!.textContent).toContain('读不到（未挂载）')
  })

  it('says the status is unavailable when the first read fails', () => {
    mount({ checkedAt: 1, stale: true })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到系统状态，稍后自动重试。')
    expect(screen.queryAllByRole('meter')).toEqual([])
  })
})
