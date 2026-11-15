/**
 * Who controls the browser: the transition the tools and the page both read,
 * and the refusal an agent action gets while the user holds it.
 */

import { describe, expect, it, vi } from 'vitest'
import { TakeoverState, UserHoldsBrowserError, type TakeoverView } from '../src/takeover.ts'

describe('TakeoverState', () => {
  it('starts with the agent in control and no stated reason', () => {
    expect(new TakeoverState().view()).toEqual({ holder: 'agent' })
  })

  it('hands control to the user with their reason and notifies once', () => {
    const state = new TakeoverState()
    const seen: TakeoverView[] = []
    state.onChange((view) => { seen.push(view) })
    state.take('  sign in to the account  ')
    expect(state.holder).toBe('human')
    expect(state.view()).toEqual({ holder: 'human', reason: 'sign in to the account' })
    expect(seen).toEqual([{ holder: 'human', reason: 'sign in to the account' }])
  })

  it('keeps an empty reason as no reason and does not notify an unchanged takeover', () => {
    const state = new TakeoverState()
    state.take('   ')
    expect(state.view()).toEqual({ holder: 'human' })
    const listener = vi.fn<(view: TakeoverView) => void>()
    state.onChange(listener)
    state.take('')
    expect(listener).not.toHaveBeenCalled()
  })

  it('refuses an agent action while the user holds control, naming the reason', () => {
    const state = new TakeoverState()
    state.take('finish the checkout')
    expect(() => { state.assertAgent() }).toThrow(UserHoldsBrowserError)
    expect(() => { state.assertAgent() }).toThrow('the user holds the browser (finish the checkout); call headless_browser_hand_back')
  })

  it('releases once, notifies the agent, and accepts actions again', () => {
    const state = new TakeoverState()
    const listener = vi.fn<(view: TakeoverView) => void>()
    state.take('sign in')
    state.onChange(listener)
    expect(state.release()).toBe(true)
    expect(listener).toHaveBeenCalledWith({ holder: 'agent' })
    expect(state.release()).toBe(false)
    expect(() => { state.assertAgent() }).not.toThrow()
  })

  it('stops notifying after the listener is disposed', () => {
    const state = new TakeoverState()
    const listener = vi.fn<(view: TakeoverView) => void>()
    const dispose = state.onChange(listener)
    dispose()
    state.take('sign in')
    expect(listener).not.toHaveBeenCalled()
  })
})
