/**
 * Form tools for the steps a sign-up or application form needs beyond click
 * and type: attaching a local file to a file input, and creating or signing in
 * to a site account with a password the model never sees.
 *
 * `headless_browser_upload` attaches files only from the configured upload
 * directories ({@link UploadPolicy}). `headless_browser_credential` generates a
 * password into the browser's own store ({@link CredentialVault}) and writes it
 * into the page; its results name the account, never the password, so the
 * secret stays out of the model's context, the Session log, and the tool log.
 *
 * @module @deepseek-ai/dsh-headless-browser/form-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  credentialHost,
  credentialView,
  type CredentialView,
  type SiteCredentialRecord,
} from './credentials.ts'
import type { ActionOutcome, AttachOutcome, AttachTarget, SecretField, TargetRequest } from './session.ts'
import type { TakeoverState } from './takeover.ts'
import {
  BLOCKED_SCHEMA,
  ERROR_SCHEMA,
  TARGET_SCHEMA,
  attempt,
  describeTarget,
  guarded,
  outcomeFields,
  pageText,
  registerTool,
  renderJson,
  targetOf,
  type TargetArgs,
} from './tools.ts'
import { MAX_UPLOAD_FILES, type UploadFile } from './uploads.ts'

/** The browser operations the form tools call; the session class satisfies them. */
export interface FormBrowser {
  pageUrl(tabId?: string): Promise<string>
  fieldUrl(request: TargetRequest, tabId?: string): Promise<string>
  fillSecret(request: TargetRequest, secret: string, field: SecretField, host: string, tabId?: string): Promise<ActionOutcome>
  attachFiles(target: AttachTarget, paths: readonly string[], tabId?: string): Promise<AttachOutcome>
}

/** The credential store operations the tool calls. */
export interface FormCredentials {
  list(): Promise<CredentialView[]>
  create(request: {
    host: string
    username: string
    label?: string
    length?: number
    symbols?: boolean
    replace?: boolean
  }): Promise<SiteCredentialRecord>
  find(host: string, username?: string): Promise<SiteCredentialRecord>
  touch(id: string): Promise<void>
  remove(id: string): Promise<boolean>
}

/** The upload check the tool calls. */
export interface FormUploads {
  readonly dirs: readonly string[]
  resolve(files: readonly string[]): Promise<UploadFile[]>
}

/** What the form tools act on. */
export interface FormToolDeps {
  readonly browser: FormBrowser
  readonly takeover: TakeoverState
  readonly credentials: FormCredentials
  readonly uploads: FormUploads
  readonly log: Pick<Context['logger'], 'info' | 'warn'>
}

/** A saved account as a result carries it. */
const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    host: { type: 'string', required: true },
    username: { type: 'string', required: true },
    label: { type: 'string' },
    createdAt: { type: 'string', required: true },
    lastUsedAt: { type: 'string' },
    replacedAt: { type: 'string' },
  },
} as const

/** Arguments of `headless_browser_upload`. */
interface UploadArgs {
  readonly files: string[]
  readonly selector?: string
  readonly index?: number
  readonly trigger?: string
  readonly triggerAxId?: string
  readonly tab?: string
}

/** Arguments of `headless_browser_credential`. */
interface CredentialArgs extends TargetArgs {
  readonly action: 'create' | 'fill' | 'list'
  readonly field?: SecretField
  readonly confirmSelector?: string
  readonly username?: string
  readonly label?: string
  readonly length?: number
  readonly symbols?: boolean
  readonly replace?: boolean
  readonly tab?: string
}

/**
 * Read the one element an upload call named: the file input, or the button that opens the file chooser.
 * @param args - the tool arguments.
 * @returns the target, or `undefined` when the call named none or more than one.
 */
function attachTargetOf(args: UploadArgs): AttachTarget | undefined {
  const named: AttachTarget[] = [
    ...args.selector === undefined ? [] : [{ selector: args.selector, ...args.index === undefined ? {} : { index: args.index } }],
    ...args.trigger === undefined ? [] : [{ trigger: { selector: args.trigger } }],
    ...args.triggerAxId === undefined ? [] : [{ trigger: { axId: args.triggerAxId } }],
  ]
  return named.length === 1 ? named[0] : undefined
}

/**
 * Register `headless_browser_upload` and `headless_browser_credential`.
 * @param ctx - the mounting scope's context.
 * @param deps - the browser, control state, credential store, and upload policy.
 */
export function registerFormTools(ctx: Context, deps: FormToolDeps): void {
  registerTool(ctx, defineTool({
    name: 'headless_browser_upload',
    description: `Attach local files to a file input on the page (a résumé, a transcript, a cover letter). Name the input with selector — it may be hidden behind a styled button, which is normal — or name the visible button that opens the file chooser with trigger. Files are absolute paths or bare names inside the upload directories; anything else is refused. At most ${String(MAX_UPLOAD_FILES)} files per call.`,
    parameters: {
      files: { type: 'array', items: { type: 'string' }, required: true, description: 'Absolute paths, or bare file names in the first upload directory.' },
      selector: { type: 'string', description: 'CSS selector of the input[type=file]; e.g. input[type=file] or #resume-upload input[type=file].' },
      index: { type: 'integer', description: 'Which matching file input, counting from 0 in document order; 0 when omitted.' },
      trigger: { type: 'string', description: 'CSS selector of the visible button that opens the file chooser, instead of selector.' },
      triggerAxId: { type: 'string', description: 'Accessibility id of that button, instead of trigger.' },
      tab: { type: 'string', description: 'Tab id; the active tab when omitted.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              attached: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { name: { type: 'string', required: true }, bytes: { type: 'integer', required: true } },
                },
              },
              ref: { type: 'string', required: true },
              url: { type: 'string', required: true },
              inputs: { type: 'integer' },
              target: TARGET_SCHEMA,
            },
          },
          BLOCKED_SCHEMA,
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async (args: UploadArgs) => {
      const target = attachTargetOf(args)
      if (target === undefined) return { error: 'give exactly one of selector (the file input), trigger, or triggerAxId' }
      return await guarded(deps, 'attaching files', async () => {
        const files = await deps.uploads.resolve(args.files)
        const outcome = await deps.browser.attachFiles(target, files.map(file => file.path), args.tab)
        return {
          attached: files.map(file => ({ name: file.name, bytes: file.bytes })),
          ref: outcome.ref,
          url: outcome.url,
          ...outcome.inputs === undefined ? {} : { inputs: outcome.inputs },
          ...outcome.target === undefined ? {} : {
            target: {
              ref: outcome.target.ref,
              index: outcome.target.index,
              name: pageText(outcome.url, outcome.target.name),
              score: outcome.target.score,
            },
          },
        }
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: `Attach ${args.files.join(', ')}`,
      kind: 'execute',
    }),
  }))

  registerTool(ctx, defineTool({
    name: 'headless_browser_credential',
    description: [
      'The browser\'s own password manager for site accounts. You never see or choose a password.',
      'create: on a sign-up or new-password form, generate a strong password for this page\'s host and the given username (the e-mail the account uses), save it, and write it into the password field (selector) and, when the form repeats it, the confirm field (confirmSelector).',
      'fill: on a sign-in form, write the saved username (field username) or password (field password, the default) for this page\'s host.',
      'list: the saved accounts, without passwords.',
      'A saved password is written only on the host it was created for and only into an input[type=password]. Results never contain the password.',
    ].join(' '),
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'fill', 'list'], description: 'create a new account password, fill a saved one, or list the saved accounts.' },
      selector: { type: 'string', description: 'CSS selector of the field to write (create and fill).' },
      axId: { type: 'string', description: 'Accessibility id of the field, instead of selector.' },
      confirmSelector: { type: 'string', description: 'The "confirm password" field, which receives the same password (create, and fill with field password).' },
      field: { type: 'string', enum: ['password', 'username'], description: 'fill only: which half of the account to write; password when omitted.' },
      username: { type: 'string', description: 'create: the login name (usually the e-mail address) of the new account; fill: which account, when the host has several.' },
      label: { type: 'string', description: 'create only: a short label for the owner, such as the company name.' },
      length: { type: 'integer', description: `create only: password length, ${String(MIN_PASSWORD_LENGTH)} through ${String(MAX_PASSWORD_LENGTH)}; ${String(DEFAULT_PASSWORD_LENGTH)} when omitted. Use the site's stated maximum when it has one.` },
      symbols: { type: 'boolean', description: 'create only: include symbols; false when the site accepts only letters and digits.' },
      replace: { type: 'boolean', description: 'create only: replace the saved password of this host and username — only on the site\'s own reset or new-password form.' },
      tab: { type: 'string', description: 'Tab id; the active tab when omitted.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', required: true },
              account: ACCOUNT_SCHEMA,
              accounts: { type: 'array', items: ACCOUNT_SCHEMA },
              wrote: { type: 'array', items: { type: 'string' } },
              url: { type: 'string' },
              target: TARGET_SCHEMA,
              note: { type: 'string' },
            },
          },
          BLOCKED_SCHEMA,
          ERROR_SCHEMA,
        ],
      },
      render: renderJson,
    },
    execute: async (args: CredentialArgs) => {
      if (args.action === 'list') {
        return await attempt('listing saved accounts', async () => ({ action: 'list', accounts: await deps.credentials.list() }))
      }
      const parsed = targetOf({
        ...args.selector === undefined ? {} : { selector: args.selector },
        ...args.axId === undefined ? {} : { axId: args.axId },
      })
      if (!parsed.ok) return { error: 'give the field to write as selector or axId' }
      if (args.action === 'create') {
        const username = args.username
        if (username === undefined || username.trim() === '') return { error: 'create needs username: the login name (usually the e-mail address) of the new account' }
        return await guarded(deps, 'creating a saved password', async () => {
          const host = credentialHost(await deps.browser.fieldUrl(parsed.request, args.tab))
          const record = await deps.credentials.create({
            host,
            username,
            ...args.label === undefined ? {} : { label: args.label },
            ...args.length === undefined || args.length === 0 ? {} : { length: args.length },
            ...args.symbols === undefined ? {} : { symbols: args.symbols },
            ...args.replace === undefined ? {} : { replace: args.replace },
          })
          deps.log.info('headless-browser: saved a new password for %s on %s (%s)', record.username, record.host, record.id)
          const wrote: string[] = []
          let first: ActionOutcome
          try {
            first = await deps.browser.fillSecret(parsed.request, record.password, 'password', record.host, args.tab)
          } catch (error: unknown) {
            // Nothing reached the page, so a new record would only make the next create fail as a duplicate.
            if (args.replace !== true) await deps.credentials.remove(record.id)
            throw error
          }
          wrote.push(first.target?.ref ?? describeTarget(parsed.request))
          if (args.confirmSelector !== undefined) {
            await deps.browser.fillSecret({ selector: args.confirmSelector }, record.password, 'password', record.host, args.tab)
            wrote.push(args.confirmSelector)
          }
          await deps.credentials.touch(record.id)
          return {
            action: 'create',
            account: credentialView(record),
            wrote,
            url: first.url,
            ...outcomeFields(first.url, first),
            note: 'The password is saved and written; submit the sign-up form next. If the site then reports the account already exists, sign in with action fill or use the site\'s reset flow.',
          }
        })
      }
      const field: SecretField = args.field ?? 'password'
      return await guarded(deps, 'filling a saved credential', async () => {
        const host = credentialHost(await deps.browser.fieldUrl(parsed.request, args.tab))
        const record = await deps.credentials.find(host, args.username)
        const value = field === 'password' ? record.password : record.username
        const outcome = await deps.browser.fillSecret(parsed.request, value, field, record.host, args.tab)
        const wrote = [outcome.target?.ref ?? describeTarget(parsed.request)]
        if (field === 'password' && args.confirmSelector !== undefined) {
          await deps.browser.fillSecret({ selector: args.confirmSelector }, value, 'password', record.host, args.tab)
          wrote.push(args.confirmSelector)
        }
        if (field === 'password') await deps.credentials.touch(record.id)
        deps.log.info('headless-browser: filled the saved %s of %s on %s (%s)', field, record.username, record.host, record.id)
        return {
          action: 'fill',
          account: credentialView(record),
          wrote,
          url: outcome.url,
          ...outcomeFields(outcome.url, outcome),
        }
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'list' ? 'List saved accounts' : args.action === 'create' ? 'Create a saved password' : 'Fill a saved credential',
      kind: args.action === 'list' ? 'read' : 'execute',
    }),
  }))
}
