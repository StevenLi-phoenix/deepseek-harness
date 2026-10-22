// @vitest-environment jsdom
/** Pasting the callback address the browser stopped on, for sign-in from a page the callback cannot reach. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CallbackPaste } from '../src/client/CallbackPaste.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const prefix = 'http://127.0.0.1:3081/oauth/callback'

function mount(submit: (url: string) => Promise<void>, copy: typeof en | typeof zh = en) {
  render(<CallbackPaste prefix={prefix} submit={submit} t={key => copy[key]} />)
  return { input: screen.getByRole('textbox', { name: copy.pasteLabel }), button: screen.getByRole('button', { name: copy.pasteSubmit }) }
}

it.each([en, zh])('names the address to paste and waits for input', (copy) => {
  const { input, button } = mount(vi.fn(async () => {}), copy)
  expect(screen.getByText(prefix).tagName).toBe('CODE')
  expect(input.getAttribute('placeholder')).toBe(`${prefix}?code=…`)
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.change(input, { target: { value: '   ' } })
  expect(button.hasAttribute('disabled')).toBe(true)
})

it('submits the pasted address as typed', async () => {
  const submit = vi.fn(async () => {})
  const { input, button } = mount(submit)
  const pasted = `${prefix}?code=c&state=s`
  fireEvent.change(input, { target: { value: pasted } })
  await act(async () => { fireEvent.click(button) })
  expect(submit).toHaveBeenCalledExactlyOnceWith(pasted)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([en, zh])('explains a rejected address and lets the user try again', async (copy) => {
  const submit = vi.fn<(url: string) => Promise<void>>().mockRejectedValueOnce(new Error('account complete failed')).mockResolvedValueOnce()
  const { input, button } = mount(submit, copy)
  fireEvent.change(input, { target: { value: `${prefix}?code=c&state=old` } })
  await act(async () => { fireEvent.click(button) })
  expect(screen.getByRole('alert').textContent).toBe(copy.pasteFailed)
  expect((input as HTMLInputElement).value).toBe(`${prefix}?code=c&state=old`)
  fireEvent.change(input, { target: { value: `${prefix}?code=c&state=new` } })
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { fireEvent.click(button) })
  expect(submit).toHaveBeenLastCalledWith(`${prefix}?code=c&state=new`)
  expect(screen.queryByRole('alert')).toBeNull()
})
