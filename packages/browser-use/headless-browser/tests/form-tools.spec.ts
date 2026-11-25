/**
 * The form tools over fakes: what each call forwards, that no result ever
 * carries a password, that a failed first write leaves no orphan record, and the
 * refusals a call gets back.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialVault } from '../src/credentials.ts'
import { registerFormTools, type FormBrowser, type FormUploads } from '../src/form-tools.ts'
import { ActionRefusedError } from '../src/guard.ts'
import { SecretFieldError, type ActionOutcome, type SecretField, type TargetRequest } from '../src/session.ts'
import { TakeoverState } from '../src/takeover.ts'
import { UploadRefusedError } from '../src/uploads.ts'

/**
 * The run context a tool body receives. These tools read none of it; the ids are
 * minted here because the executor that normally brands them is not in the test.
 */
const EXEC: ToolRunContext = {
  callId: 'form-tools-call' as ToolRunContext['callId'],
  rootCallId: 'form-tools-call' as ToolRunContext['rootCallId'],
  name: 'form-tools',
  arguments: {},
  token: Symbol('form-tools') as ToolRunContext['token'],
  signal: new AbortController().signal,
  deferContext() {},
  concludeTurn() {},
}

const HIT: ActionOutcome = { url: 'https://acme.wd5.myworkdayjobs.com/signup', target: { ref: '#password', index: 0, name: 'Password', score: 1 } }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

interface Written { readonly request: TargetRequest; readonly secret: string; readonly field: SecretField; readonly host: string }

function setup(overrides: Partial<FormBrowser> = {}, uploads?: FormUploads) {
  const page = { url: 'https://Acme.wd5.myworkdayjobs.com/en-US/careers/signup' }
  const root = mkdtempSync(join(tmpdir(), 'dsh-form-tools-'))
  roots.push(root)
  const vault = new CredentialVault(join(root, 'credentials.json'))
  const written: Written[] = []
  const browser: FormBrowser = {
    pageUrl: async () => page.url,
    fillSecret: async (request, secret, field, host) => { written.push({ request, secret, field, host }); return HIT },
    attachFiles: async () => ({ url: 'https://jobs.example.com/apply', ref: 'input[type=file]', inputs: 1 }),
    ...overrides,
  }
  const definitions = new Map<string, ToolDefinition>()
  const ctx = new Context()
  ctx.provide('tools', {
    register(definition: ToolDefinition) {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
  })
  const takeover = new TakeoverState()
  const log = { info: vi.fn(), warn: vi.fn() }
  registerFormTools(ctx, {
    browser,
    takeover,
    credentials: vault,
    uploads: uploads ?? { dirs: ['/up'], resolve: async files => files.map(name => ({ path: `/up/${name}`, name, bytes: 10 })) },
    log,
  })
  return {
    page,
    vault,
    written,
    takeover,
    log,
    definitions,
    async call(name: string, args: object): Promise<unknown> {
      const definition = definitions.get(name)
      if (definition === undefined) throw new Error(`no tool named ${name}`)
      return await definition.execute(args, EXEC)
    },
  }
}

describe('form tool registration', () => {
  it('registers upload and credential with supported schemas and titles', () => {
    const bench = setup()
    expect([...bench.definitions.keys()]).toEqual(['headless_browser_upload', 'headless_browser_credential'])
    for (const definition of bench.definitions.values()) {
      expect(() => { assertSupportedJsonSchema(definition.output.schema) }).not.toThrow()
      expect(definition.presentCall?.({ action: 'create', files: ['resume.pdf'] })).toMatchObject({ card: 'generic' })
    }
  })
})

describe('headless_browser_credential', () => {
  it('creates a password for the page host, writes it into both fields, and never returns it', async () => {
    const bench = setup()
    const result = await bench.call('headless_browser_credential', {
      action: 'create', selector: '#password', confirmSelector: '#confirm', username: 'cv@example.com', label: 'Acme',
    }) as Record<string, unknown>
    const [record] = await bench.vault.list()
    const saved = await bench.vault.find('acme.wd5.myworkdayjobs.com')
    expect(result).toMatchObject({ action: 'create', account: { id: record!.id, host: 'acme.wd5.myworkdayjobs.com', username: 'cv@example.com', label: 'Acme' }, wrote: ['#password', '#confirm'] })
    expect(bench.written.map(write => [write.request, write.field, write.host])).toEqual([
      [{ selector: '#password' }, 'password', 'acme.wd5.myworkdayjobs.com'],
      [{ selector: '#confirm' }, 'password', 'acme.wd5.myworkdayjobs.com'],
    ])
    expect(bench.written.every(write => write.secret === saved.password)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(saved.password)
    expect(JSON.stringify(bench.log.info.mock.calls)).not.toContain(saved.password)
  })

  it('creates with every optional argument filled as blank or zero', async () => {
    const bench = setup()
    const result = await bench.call('headless_browser_credential', {
      action: 'create', selector: '#password', axId: '', confirmSelector: '', field: 'password', username: 'cv@example.com',
      label: '', length: 0, replace: false, symbols: true, tab: '',
    })
    const saved = await bench.vault.find('acme.wd5.myworkdayjobs.com')
    expect(result).toMatchObject({ action: 'create', wrote: ['#password'] })
    expect(bench.written.map(write => write.request)).toEqual([{ selector: '#password' }])
    expect(saved.password).toHaveLength(20)
    expect(saved.label).toBeUndefined()
  })

  it('fills the saved username and password on a later sign-in and touches the record', async () => {
    const bench = setup()
    await bench.call('headless_browser_credential', { action: 'create', selector: '#password', username: 'cv@example.com' })
    bench.written.length = 0
    const user = await bench.call('headless_browser_credential', { action: 'fill', field: 'username', selector: '#email' })
    const pass = await bench.call('headless_browser_credential', { action: 'fill', selector: '#password' })
    const saved = await bench.vault.find('acme.wd5.myworkdayjobs.com')
    expect(bench.written.map(write => [write.field, write.secret === saved.password, write.secret])).toEqual([
      ['username', false, 'cv@example.com'],
      ['password', true, saved.password],
    ])
    expect(user).toMatchObject({ action: 'fill', wrote: ['#password'] })
    expect(JSON.stringify(pass)).not.toContain(saved.password)
    expect(saved.lastUsedAt).toBeDefined()
  })

  it('reports no saved account on another host instead of writing anything', async () => {
    const bench = setup()
    await bench.call('headless_browser_credential', { action: 'create', selector: '#password', username: 'cv@example.com' })
    bench.written.length = 0
    bench.page.url = 'https://evil.example.net/login'
    expect(await bench.call('headless_browser_credential', { action: 'fill', selector: '#password' })).toEqual({
      error: 'no saved password for evil.example.net; on the site\'s sign-up form use action create, or hand over if the account was made outside this browser',
    })
    expect(bench.written).toEqual([])
  })

  it('drops a new record whose first write the page refused, so a retry is not a duplicate', async () => {
    const bench = setup({ fillSecret: async () => { throw new SecretFieldError('#name is not a password input (input[type=password]); a saved password is only written into one') } })
    expect(await bench.call('headless_browser_credential', { action: 'create', selector: '#name', username: 'cv@example.com' })).toEqual({
      error: '#name is not a password input (input[type=password]); a saved password is only written into one',
    })
    expect(await bench.vault.list()).toEqual([])
  })

  it('turns a guard refusal into a blocked result', async () => {
    const refusal = new ActionRefusedError({
      rule: 'visibility', url: HIT.url, ref: '#password', name: { untrusted: 'https://acme.wd5.myworkdayjobs.com', content: '' },
      reason: 'hidden', hint: 'hand over', failing: ['display'],
    })
    const bench = setup({ fillSecret: async () => { throw refusal } })
    const result = await bench.call('headless_browser_credential', { action: 'create', selector: '#password', username: 'cv@example.com' })
    expect(result).toMatchObject({ blocked: { rule: 'visibility', ref: '#password' } })
  })

  it('needs a username to create, a field to write, and the agent holding the browser', async () => {
    const bench = setup()
    expect(await bench.call('headless_browser_credential', { action: 'create', selector: '#password' })).toMatchObject({ error: expect.stringContaining('create needs username') })
    expect(await bench.call('headless_browser_credential', { action: 'fill' })).toEqual({ error: 'give the field to write as selector or axId' })
    bench.takeover.take('用户从接管页取得控制')
    expect(await bench.call('headless_browser_credential', { action: 'fill', selector: '#password' })).toMatchObject({ error: expect.stringContaining('用户') })
  })

  it('lists saved accounts without passwords', async () => {
    const bench = setup()
    await bench.call('headless_browser_credential', { action: 'create', selector: '#password', username: 'cv@example.com' })
    const listed = await bench.call('headless_browser_credential', { action: 'list' }) as { accounts: unknown[] }
    expect(listed.accounts).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain((await bench.vault.find('acme.wd5.myworkdayjobs.com')).password)
  })
})

describe('headless_browser_upload', () => {
  it('attaches the cleared files to the file input and reports names and sizes', async () => {
    const attachFiles = vi.fn<FormBrowser['attachFiles']>(async () => ({ url: 'https://jobs.example.com/apply', ref: '#resume', inputs: 2 }))
    const bench = setup({ attachFiles })
    expect(await bench.call('headless_browser_upload', { files: ['resume.pdf'], selector: '#resume', index: 1 })).toEqual({
      attached: [{ name: 'resume.pdf', bytes: 10 }], ref: '#resume', url: 'https://jobs.example.com/apply', inputs: 2,
    })
    expect(attachFiles).toHaveBeenCalledWith({ selector: '#resume', index: 1 }, ['/up/resume.pdf'], undefined)
  })

  it('passes a trigger through as a guarded click target', async () => {
    const attachFiles = vi.fn<FormBrowser['attachFiles']>(async () => ({
      url: 'https://jobs.example.com/apply', ref: 'button.upload', target: { ref: 'button.upload', index: 0, name: 'Upload résumé', score: 0.9 },
    }))
    const bench = setup({ attachFiles })
    expect(await bench.call('headless_browser_upload', { files: ['resume.pdf'], trigger: 'button.upload', tab: 't2' })).toMatchObject({
      ref: 'button.upload', target: { name: { untrusted: 'https://jobs.example.com', content: 'Upload résumé' } },
    })
    expect(attachFiles).toHaveBeenCalledWith({ trigger: { selector: 'button.upload' } }, ['/up/resume.pdf'], 't2')
  })

  it('takes the trigger when the selector and tab are blank', async () => {
    const attachFiles = vi.fn<FormBrowser['attachFiles']>(async () => ({ url: 'https://jobs.example.com/apply', ref: 'button.upload' }))
    const bench = setup({ attachFiles })
    await bench.call('headless_browser_upload', { files: ['resume.pdf'], selector: '', index: 0, trigger: 'button.upload', triggerAxId: '', tab: '' })
    expect(attachFiles).toHaveBeenCalledWith({ trigger: { selector: 'button.upload' } }, ['/up/resume.pdf'], undefined)
  })

  it('refuses a file the upload policy refuses, and a call with no or two targets', async () => {
    const bench = setup({}, { dirs: ['/up'], resolve: async () => { throw new UploadRefusedError('/etc/passwd is outside the upload directories (/up); copy the file there first') } })
    expect(await bench.call('headless_browser_upload', { files: ['/etc/passwd'], selector: 'input[type=file]' })).toEqual({
      error: '/etc/passwd is outside the upload directories (/up); copy the file there first',
    })
    expect(await bench.call('headless_browser_upload', { files: ['resume.pdf'] })).toMatchObject({ error: expect.stringContaining('exactly one') })
    expect(await bench.call('headless_browser_upload', { files: ['resume.pdf'], selector: 'a', trigger: 'b' })).toMatchObject({ error: expect.stringContaining('exactly one') })
  })
})
