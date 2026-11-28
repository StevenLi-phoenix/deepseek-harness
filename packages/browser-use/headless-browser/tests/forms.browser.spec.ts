/**
 * REAL browser coverage of the form steps: a saved password lands only in a
 * password input on its own host, and files reach a hidden file input or the
 * chooser a styled button opens. Skips cleanly when Playwright has no Chromium
 * for this machine.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { Context } from '@deepseek-ai/cordis'
import { HeadlessBrowserSession, SecretFieldError } from '../src/session.ts'
import { ActionGuard, ActionRefusedError } from '../src/guard.ts'

const AVAILABLE = existsSync(chromium.executablePath())

const FORM = `<!doctype html><title>signup</title><style>html { scroll-behavior: smooth }</style><body>
<label>Email <input id="email" type="email"></label>
<label>Password <input id="password" type="password"></label>
<label>Confirm <input id="confirm" type="password"></label>
<label>Not a password <input id="name" type="text" placeholder="password"></label>
<label class="upload" for="resume">Upload résumé <input id="resume" type="file" style="display:none"></label>
<input id="many" type="file" multiple style="opacity:0;position:absolute;width:1px;height:1px">
<button id="chooser" type="button">Attach transcript</button>
<span class="attachmentLabel" style="position:relative;display:inline-block"><span id="sfLabel">Upload from Device</span><input id="sf" type="file" aria-labelledby="sfLabel" style="opacity:0;position:absolute;left:0;top:0;width:100%;height:100%"></span>
<button id="google" type="button" onclick="window.open('/popup', 'signin', 'width=480,height=600')">Continue with Google</button>
<div style="position:relative;width:180px;height:40px"><button id="reset" type="button" aria-hidden="true" tabindex="-1" style="width:180px;height:40px">Reset Password</button><div id="cover" role="button" tabindex="0" aria-label="Reset Password" style="position:absolute;inset:0" onclick="document.getElementById('shown').textContent = 'reset sent'"></div></div>
<div style="position:relative;width:180px;height:40px"><button id="decoy" type="button" aria-hidden="true" tabindex="-1" style="width:180px;height:40px" onclick="document.getElementById('shown').textContent = 'decoy'">Show details</button><div role="button" tabindex="0" aria-label="Continue" style="position:absolute;inset:0"></div></div>
<label for="country">Country</label><div id="control" style="display:flex;width:240px;height:36px;border:1px solid #888"><div style="flex:1;overflow:hidden;padding:2px 8px"><div style="display:inline-grid"><input id="country" role="combobox" aria-autocomplete="list" style="width:2px;height:20px;border:0;padding:0"></div></div></div>
<input id="trap" aria-label="Notes" style="width:2px;height:20px;border:0;padding:0">
<label for="city">City</label><input id="city" aria-autocomplete="list" aria-controls="city-list" aria-expanded="false"><div id="city-list" role="listbox"></div><input id="city-value" type="hidden">
<label>Work authorization <select id="auth"><option value="">Select…</option><option value="yes">Yes, I am authorized</option><option value="no">No</option></select></label>
<iframe id="embedded" src="/inner" style="width:600px;height:300px;border:0"></iframe>
<div id="outer-host"></div>
<div style="position:relative;width:24px;height:24px"><input id="terms" type="checkbox" aria-label="I agree" style="opacity:0;position:absolute;inset:0;width:24px;height:24px;margin:0;z-index:1"><div style="position:absolute;left:3px;top:3px;width:18px;height:18px;border:1px solid #333"></div></div>
<input id="optin" type="checkbox" aria-label="Share my data" style="opacity:0;width:24px;height:24px;margin:0">
<p id="shown"></p>
<div style="height:2400px"></div><label>Late <input id="late"></label>
<script>
  // SmartRecruiters-style field: an input two open shadow roots deep.
  const inner = document.createElement('div')
  document.getElementById('outer-host').attachShadow({ mode: 'open' }).append(inner)
  inner.attachShadow({ mode: 'open' }).innerHTML = '<label>City <input id="deep-city" style="width:220px;height:28px"></label>'
</script>
<script>
  const picker = document.createElement('input'); picker.type = 'file'; picker.id = 'picker'
  document.getElementById('chooser').addEventListener('click', () => picker.click())
  const show = () => { document.getElementById('shown').textContent = [...document.querySelectorAll('input[type=file]'), picker].map(i => i.id + ':' + [...i.files].map(f => f.name + '/' + f.size).join('+')).join(' ') }
  for (const i of [...document.querySelectorAll('input[type=file]'), picker]) i.addEventListener('change', show)
  const city = document.getElementById('city'); const list = document.getElementById('city-list')
  city.addEventListener('input', () => {
    // Like react-select: the list opens on keystrokes, never on a written value.
    list.replaceChildren()
    if (!city.dataset.keyed) return
    for (const [i, name] of ['New York', 'New Haven', 'Toronto'].entries()) {
      if (!name.toLowerCase().startsWith(city.value.toLowerCase())) continue
      const option = document.createElement('div'); option.role = 'option'; option.id = 'city-option-' + i; option.textContent = name
      option.addEventListener('click', () => { document.getElementById('city-value').value = name; city.value = ''; list.replaceChildren() })
      list.append(option)
    }
  })
  city.addEventListener('keydown', () => { city.dataset.keyed = '1' })
</script>`

const POPUP = `<!doctype html><title>Sign in</title><body><p>Choose an account</p>
<button id="account" type="button" onclick="window.opener.document.getElementById('shown').textContent = 'signed in'; window.close()">cv@example.com</button>`

const CONSENT = `<!doctype html><title>Engineer</title><body>
<button id="apply" type="button" style="width:140px;height:44px" onclick="document.getElementById('shown').textContent = 'applying'">Apply Now</button><p id="shown"></p>
<div id="filter" class="onetrust-pc-dark-filter" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1"></div>
<div id="banner" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#fff;z-index:2"><button id="accept" type="button" onclick="document.getElementById('filter').remove(); document.getElementById('banner').remove()">Accept All Cookies</button></div>`

const INNER = '<!doctype html><title>Enter your information</title><body><label>Email <input id="inner-email" type="email"></label><label>Password <input id="inner-password" type="password"></label>'

// A Workday prompt: the search box lists matches only after Enter, never on keystrokes.
const WORKDAY = `<!doctype html><title>My Experience</title><body>
<label for="school">School or University</label><input id="school" role="combobox" aria-controls="school-list" aria-expanded="false" placeholder="Search" style="width:240px;height:28px"><div id="school-list" role="listbox"></div><input id="school-value" type="hidden">
<label for="field">Field of Study</label><input id="field" placeholder="Search" style="width:240px;height:28px"><div id="field-list" role="listbox"></div><p id="field-value"></p>
<div style="position:relative;width:376px;height:40px"><button id="signin" type="submit" aria-hidden="true" tabindex="-2" style="width:376px;height:40px">Sign In</button><div id="filter" role="button" tabindex="0" aria-label="Submit" data-automation-id="click_filter" style="position:absolute;inset:0" onclick="document.getElementById('signed').textContent = 'signed in'"></div></div><p id="signed"></p>
<script>
  for (const [id, names] of [['school', ['New York University', 'New York Institute of Technology']], ['field', ['Computer Science', 'Computer Engineering']]]) {
    const input = document.getElementById(id); const list = document.getElementById(id + '-list')
    input.addEventListener('input', () => { list.replaceChildren() })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      list.replaceChildren()
      for (const [i, name] of names.entries()) {
        if (!name.toLowerCase().includes(input.value.toLowerCase())) continue
        const option = document.createElement('div'); option.role = 'option'; option.id = id + '-option-' + i; option.textContent = name
        option.style.cssText = 'width:240px;height:24px'
        option.addEventListener('click', () => { document.getElementById(id + '-value')[id === 'school' ? 'value' : 'textContent'] = name; list.replaceChildren() })
        list.append(option)
      }
    })
  }
</script>`

// An Eightfold-style menu: the list fades in over 600 ms after a keystroke, so its
// options start at opacity 0. The ghost list never becomes visible.
const FADE = `<!doctype html><title>Contact</title><body>
<label for="device">Phone Device Type</label><input id="device" role="combobox" aria-controls="device-list" aria-expanded="false" style="width:240px;height:28px"><div id="device-list" role="listbox" style="opacity:0;transition:opacity 600ms linear"></div><p id="device-value"></p>
<label for="ghost">Ghost</label><input id="ghost" role="combobox" aria-controls="ghost-list" aria-expanded="false" style="width:240px;height:28px"><div id="ghost-list" role="listbox" style="opacity:0"></div><p id="ghost-value"></p>
<script>
  for (const id of ['device', 'ghost']) {
    const input = document.getElementById(id); const list = document.getElementById(id + '-list')
    input.addEventListener('keydown', () => {
      if (list.childElementCount > 0) return
      for (const [i, name] of ['Mobile', 'Home', 'Work'].entries()) {
        const option = document.createElement('div'); option.role = 'option'; option.id = id + '-option-' + i; option.textContent = name
        option.style.cssText = 'width:240px;height:24px'
        option.addEventListener('click', () => { document.getElementById(id + '-value').textContent = name; list.replaceChildren() })
        list.append(option)
      }
      if (id === 'device') requestAnimationFrame(() => requestAnimationFrame(() => { list.style.opacity = '1' }))
    })
  }
</script>`

interface App {
  readonly base: string
  readonly browser: HeadlessBrowserSession
  readonly files: string
  close(): Promise<void>
}

const apps: App[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

async function boot(options: { readonly sensitiveActions?: boolean } = {}): Promise<App> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-forms-live-'))
  const files = join(root, 'uploads')
  const server: Server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(request.url === '/popup' ? POPUP : request.url === '/inner' ? INNER : request.url === '/consent' ? CONSENT : request.url === '/workday' ? WORKDAY : request.url === '/fade' ? FADE : FORM)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const ctx = new Context()
  const browser = new HeadlessBrowserSession({
    profileDir: join(root, 'profile'),
    headless: true,
    stealth: true,
    sensitiveActions: options.sensitiveActions ?? true,
    viewportWidth: 1280,
    viewportHeight: 800,
    jpegQuality: 50,
    snapshotDir: join(root, 'snapshots'),
    keepalivePath: join(root, 'keepalive.json'),
    keepaliveEscalateAfter: 3,
    downloadDir: join(root, 'downloads'),
    maxDownloadMB: 256,
    downloadRetainDays: 7,
    downloadPdfs: true,
    credentialsPath: join(root, 'credentials.json'),
    uploadDirs: [files],
    maxUploadMB: 25,
  }, ctx.logger, new ActionGuard({ sensitiveActions: options.sensitiveActions ?? true }))
  mkdirSync(files)
  writeFileSync(join(files, 'resume.pdf'), 'resume-bytes')
  writeFileSync(join(files, 'transcript.pdf'), 'transcript')
  const app: App = {
    base: `http://127.0.0.1:${String(port)}`,
    browser,
    files,
    async close() {
      await browser.close()
      await ctx.fiber.dispose()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      rmSync(root, { recursive: true, force: true })
    },
  }
  apps.push(app)
  return app
}

async function value(app: App, selector: string): Promise<string> {
  const page = await app.browser.page()
  return await page.locator(selector).inputValue()
}

describe.skipIf(!AVAILABLE)('form steps in a real page', () => {
  it('writes a secret into a password input on its own host and refuses a text box or another host', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/signup`)
    expect(await app.browser.pageUrl()).toBe(`${app.base}/signup`)
    await app.browser.fillSecret({ selector: '#password' }, 'S3cret!pass-Word', 'password', '127.0.0.1')
    await app.browser.fillSecret({ selector: '#email' }, 'cv@example.com', 'username', '127.0.0.1')
    expect(await value(app, '#password')).toBe('S3cret!pass-Word')
    expect(await value(app, '#email')).toBe('cv@example.com')
    await expect(app.browser.fillSecret({ selector: '#name' }, 'S3cret!pass-Word', 'password', '127.0.0.1')).rejects.toThrow(SecretFieldError)
    expect(await value(app, '#name')).toBe('')
    await expect(app.browser.fillSecret({ selector: '#confirm' }, 'S3cret!pass-Word', 'password', 'jobs.example.com')).rejects.toThrow(/not jobs\.example\.com/u)
    expect(await value(app, '#confirm')).toBe('')
    await expect(app.browser.fillSecret({ point: { x: 10, y: 10 } }, 'x', 'password', '127.0.0.1')).rejects.toThrow(/never a point/u)
  }, 120_000)

  it('attaches a file to a hidden file input, several to a multiple input, one through a chooser button, and one through a trigger that names the input', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const resume = join(app.files, 'resume.pdf')
    const transcript = join(app.files, 'transcript.pdf')
    expect(await app.browser.attachFiles({ selector: '#resume' }, [resume])).toMatchObject({ ref: '#resume', inputs: 1 })
    expect(await app.browser.attachFiles({ selector: 'input[type=file]', index: 1 }, [resume, transcript])).toMatchObject({ inputs: 3 })
    const viaChooser = await app.browser.attachFiles({ trigger: { selector: '#chooser' } }, [transcript])
    expect(viaChooser.target?.name).toBe('Attach transcript')
    // SAP SuccessFactors labels its transparent file input "Upload from Device", so the trigger names the input itself.
    expect(await app.browser.attachFiles({ trigger: { selector: 'role=button[name="Upload from Device"]' } }, [resume])).toMatchObject({ inputs: 1 })
    const page = await app.browser.page()
    expect(await page.locator('#shown').textContent()).toBe('resume:resume.pdf/12 many:resume.pdf/12+transcript.pdf/10 sf:resume.pdf/12 picker:transcript.pdf/10')
    await expect(app.browser.attachFiles({ selector: '#email' }, [resume])).rejects.toThrow(/matches no input\[type=file\]/u)
    await expect(app.browser.attachFiles({ selector: '#resume' }, [resume, transcript])).rejects.toThrow(/takes one file/u)
  }, 120_000)

  it('turns a sign-in popup into the active tab, acts in it, and returns to the opener when it closes', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const opened = await app.browser.click({ selector: '#google' })
    expect(opened.popups).toHaveLength(1)
    const popup = opened.popups![0]!
    expect(popup.opener).toBe('t1')
    expect(app.browser.tabsState().find(tab => tab.active)?.id).toBe(popup.tab)
    await expect.poll(async () => await app.browser.pageUrl(popup.tab)).toBe(`${app.base}/popup`)
    await app.browser.click({ selector: '#account' }, popup.tab)
    await expect.poll(() => app.browser.tabsState().map(tab => [tab.id, tab.active])).toEqual([['t1', true]])
    const page = await app.browser.page()
    expect(await page.locator('#shown').textContent()).toBe('signed in')
  }, 120_000)

  it('clicks the same-name overlay that covers a hidden button, and still refuses a covered decoy', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const page = await app.browser.page()
    const outcome = await app.browser.click({ selector: "button:has-text('Reset Password')" })
    expect(outcome.target).toMatchObject({ index: 1, name: 'Reset Password' })
    expect(await page.locator('#shown').textContent()).toBe('reset sent')
    await expect(app.browser.click({ selector: '#decoy' })).rejects.toThrow(/scored 0\.00/u)
    expect(await page.locator('#shown').textContent()).toBe('reset sent')
  }, 120_000)

  it('chooses a native select option by its text, types into a caret-wide combobox, and refuses a caret-wide plain input', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const chosen = await app.browser.fill({ selector: '#auth' }, 'yes, i am authorized')
    expect(chosen.selected).toBe('Yes, I am authorized')
    expect(await value(app, '#auth')).toBe('yes')
    await app.browser.fill({ selector: '#auth' }, 'no')
    expect(await value(app, '#auth')).toBe('no')
    await expect(app.browser.fill({ selector: '#auth' }, 'Maybe')).rejects.toThrow(/no single option of #auth/u)
    const typed = await app.browser.fill({ selector: '#country' }, 'United States')
    expect(typed.target?.score).toBeGreaterThan(0.2)
    expect(await value(app, '#country')).toBe('United States')
    await expect(app.browser.fill({ selector: '#trap' }, 'x')).rejects.toThrow(/area/u)
  }, 120_000)

  it('types into a field nested two open shadow roots deep', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const typed = await app.browser.fill({ selector: '#deep-city' }, 'Brooklyn')
    expect(typed.target?.score).toBeGreaterThan(0.8)
    const page = await app.browser.page()
    expect(await page.locator('#deep-city').inputValue()).toBe('Brooklyn')
  }, 120_000)

  it('types into a searchable dropdown with keystrokes and clicks the one option the text names', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const page = await app.browser.page()
    const picked = await app.browser.fill({ selector: '#city' }, 'toronto')
    expect(picked.selected).toBe('Toronto')
    expect(await page.locator('#city-value').inputValue()).toBe('Toronto')
    const ambiguous = await app.browser.fill({ selector: '#city' }, 'New')
    expect(ambiguous.selected).toBeUndefined()
    expect(await value(app, '#city')).toBe('New')
    expect(await page.locator('#city-list [role=option]').count()).toBe(2)
    await app.browser.click({ selector: "#city-list [role=option]:has-text('New Haven')" })
    expect(await page.locator('#city-value').inputValue()).toBe('New Haven')
  }, 120_000)

  it('presses Enter for a search box that lists its matches only on Enter, as a Workday prompt does', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/workday`)
    const page = await app.browser.page()
    const silent = await app.browser.fill({ selector: '#school' }, 'New York University')
    expect(silent.selected).toBeUndefined()
    expect(await page.locator('#school-list [role=option]').count()).toBe(0)
    const picked = await app.browser.fill({ selector: '#school' }, 'New York University', undefined, { enter: true })
    expect(picked.selected).toBe('New York University')
    expect(await page.locator('#school-value').inputValue()).toBe('New York University')
    await app.browser.fill({ selector: '#field' }, 'Computer Science', undefined, { enter: true })
    expect(await page.locator('#field-list [role=option]').count()).toBe(1)
    await app.browser.click({ selector: '#field-option-0' })
    expect(await page.locator('#field-value').textContent()).toBe('Computer Science')
  }, 120_000)

  it('waits for a fading-in option list before choosing, and still refuses an option that never shows', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/fade`)
    const page = await app.browser.page()
    const picked = await app.browser.fill({ selector: '#device' }, 'Mobile')
    expect(picked.selected).toBe('Mobile')
    expect(await page.locator('#device-value').textContent()).toBe('Mobile')
    await expect(app.browser.fill({ selector: '#ghost' }, 'Mobile')).rejects.toThrow(/opacity/u)
    expect(await page.locator('#ghost-value').textContent()).toBe('')
  }, 120_000)

  it('signs in through the "Submit" overlay Workday draws over its hidden Sign In button', async () => {
    const guarded = await boot()
    await guarded.browser.open(`${guarded.base}/workday`)
    await expect(guarded.browser.click({ selector: 'button[type=submit]' })).rejects.toThrow('the target "Submit" matches the sensitive action "submit"')
    // DSH's unattended profile runs with sensitiveActions off; the overlay then takes the click.
    const app = await boot({ sensitiveActions: false })
    await app.browser.open(`${app.base}/workday`)
    const page = await app.browser.page()
    const outcome = await app.browser.click({ selector: 'button[type=submit]' })
    expect(outcome.target).toMatchObject({ index: 1, name: 'Submit' })
    expect(await page.locator('#signed').textContent()).toBe('signed in')
  }, 120_000)

  it('checks a styled checkbox through the box painted under it and refuses one nobody can see', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const page = await app.browser.page()
    const checked = await app.browser.click({ selector: '#terms' })
    expect(checked.target?.score).toBeGreaterThan(0.2)
    expect(await page.locator('#terms').isChecked()).toBe(true)
    await expect(app.browser.click({ selector: '#optin' })).rejects.toThrow(/opacity/u)
    expect(await page.locator('#optin').isChecked()).toBe(false)
  }, 120_000)

  it('measures a field below the fold where it scrolls to, under smooth scrolling', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    const typed = await app.browser.fill({ selector: '#late' }, 'below the fold')
    expect(typed.target?.score).toBeGreaterThan(0.8)
    expect(await value(app, '#late')).toBe('below the fold')
  }, 120_000)

  it('names the cookie banner that covers a button, and clicks the button once the banner is closed', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/consent`)
    const refused = await app.browser.click({ selector: '#apply' }).then(() => undefined, (error: unknown) => error)
    expect(refused).toBeInstanceOf(ActionRefusedError)
    const blocked = (refused as ActionRefusedError).blocked
    expect(blocked.failing).toContain('occlusion')
    expect(blocked.coveredBy?.content).toContain('div#filter .onetrust-pc-dark-filter')
    expect(blocked.hint).toContain('cookie banner')
    await app.browser.click({ selector: '#accept' })
    await app.browser.click({ selector: '#apply' })
    const page = await app.browser.page()
    expect(await page.locator('#shown').textContent()).toBe('applying')
  }, 120_000)

  it('reads, types and writes a credential into a form inside an embedded page', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    await expect.poll(async () => (await app.browser.read({})).text).toContain(`[frame ${app.base}/inner]`)
    const typed = await app.browser.fill({ selector: '#inner-email' }, 'cv@example.com')
    expect(typed.target?.score).toBeGreaterThan(0.8)
    expect(await app.browser.fieldUrl({ selector: '#inner-password' })).toBe(`${app.base}/inner`)
    await app.browser.fillSecret({ selector: '#inner-password' }, 'S3cret!pass-Word', 'password', '127.0.0.1')
    const frame = (await app.browser.page()).frames().find(candidate => candidate.url().endsWith('/inner'))
    expect(await frame?.locator('#inner-email').inputValue()).toBe('cv@example.com')
    expect(await frame?.locator('#inner-password').inputValue()).toBe('S3cret!pass-Word')
    await expect(app.browser.fill({ selector: '#nowhere' }, 'x')).rejects.toThrow(/no element matches #nowhere/u)
  }, 120_000)

  it('lists an embedded form page in a whole-page read', async () => {
    const app = await boot()
    await app.browser.open(`${app.base}/apply`)
    await expect.poll(async () => (await app.browser.read({})).frames?.map(frame => frame.url)).toEqual([`${app.base}/inner`])
    const [frame] = (await app.browser.read({})).frames ?? []
    expect(frame).toMatchObject({ width: 600, height: 300 })
  }, 120_000)
})
