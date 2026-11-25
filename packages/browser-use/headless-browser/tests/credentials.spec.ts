/**
 * The browser's password store: generated passwords meet common site rules,
 * records bind to one host, the file stays owner-only, secrets never appear in
 * a view, and the owner's CSV export is what Chrome's importer reads.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialError,
  CredentialVault,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  credentialHost,
  credentialView,
  generatePassword,
} from '../src/credentials.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function vaultAt(): { vault: CredentialVault; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-credentials-'))
  roots.push(root)
  const path = join(root, 'nested', 'credentials.json')
  return { vault: new CredentialVault(path, () => new Date('2026-11-24T12:00:00.000Z')), path }
}

describe('generatePassword', () => {
  it('always holds a lower-case letter, an upper-case letter, a digit, and a symbol', () => {
    for (let round = 0; round < 200; round += 1) {
      const password = generatePassword()
      expect(password).toHaveLength(20)
      expect(password).toMatch(/[a-z]/u)
      expect(password).toMatch(/[A-Z]/u)
      expect(password).toMatch(/[2-9]/u)
      expect(password).toMatch(/[!@#$%^*\-_=+?]/u)
      expect(password).not.toMatch(/[\s"'<>&\\`lIO01]/u)
    }
  })

  it('leaves symbols out when the site accepts only letters and digits, and clamps the length', () => {
    expect(generatePassword(16, false)).toMatch(/^[A-Za-z2-9]{16}$/u)
    expect(generatePassword(4)).toHaveLength(MIN_PASSWORD_LENGTH)
    expect(generatePassword(500)).toHaveLength(MAX_PASSWORD_LENGTH)
  })

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword()))
    expect(seen.size).toBe(100)
  })
})

describe('credentialHost', () => {
  it('reduces a URL or a host to the bare lower-case host', () => {
    expect(credentialHost('https://Acme.wd5.myworkdayjobs.com:443/en-US/careers/login?x=1')).toBe('acme.wd5.myworkdayjobs.com')
    expect(credentialHost('Careers-Acme.ICIMS.com.')).toBe('careers-acme.icims.com')
    expect(credentialHost('localhost:3081')).toBe('localhost')
  })

  it('refuses a value that names no host', () => {
    expect(() => credentialHost('')).toThrow(CredentialError)
    expect(() => credentialHost('not a host/path')).toThrow(CredentialError)
  })
})

describe('CredentialVault', () => {
  it('creates a record bound to the host, in a 0600 file, and lists it without the password', async () => {
    const { vault, path } = vaultAt()
    const record = await vault.create({ host: 'https://acme.wd5.myworkdayjobs.com/login', username: 'cv@example.com', label: 'Acme' })
    expect(record).toMatchObject({ host: 'acme.wd5.myworkdayjobs.com', username: 'cv@example.com', label: 'Acme', createdAt: '2026-11-24T12:00:00.000Z' })
    expect(record.id).toMatch(/^c[0-9a-f]{12}$/u)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 })
    const listed = await vault.list()
    expect(listed).toEqual([credentialView(record)])
    expect(JSON.stringify(listed)).not.toContain(record.password)
  })

  it('refuses a second account with the same login on one host unless replace is set, and keeps the old password', async () => {
    const { vault } = vaultAt()
    const first = await vault.create({ host: 'jobs.example.com', username: 'cv@example.com' })
    await expect(vault.create({ host: 'jobs.example.com', username: 'CV@example.com' })).rejects.toThrow(/already has a saved password/u)
    const replaced = await vault.create({ host: 'jobs.example.com', username: 'cv@example.com', replace: true })
    expect(replaced.id).toBe(first.id)
    expect(replaced.password).not.toBe(first.password)
    expect(replaced.previousPassword).toBe(first.password)
    expect(replaced.replacedAt).toBe('2026-11-24T12:00:00.000Z')
    expect(await vault.list()).toHaveLength(1)
  })

  it('finds only the account of the exact host, and asks for the login when a host has two', async () => {
    const { vault } = vaultAt()
    const acme = await vault.create({ host: 'acme.wd5.myworkdayjobs.com', username: 'cv@example.com' })
    await expect(vault.find('other.wd5.myworkdayjobs.com')).rejects.toThrow(/no saved password for other\.wd5\.myworkdayjobs\.com/u)
    expect((await vault.find('https://acme.wd5.myworkdayjobs.com/x')).password).toBe(acme.password)
    await vault.create({ host: 'acme.wd5.myworkdayjobs.com', username: 'second@example.com' })
    await expect(vault.find('acme.wd5.myworkdayjobs.com')).rejects.toThrow(/pass username/u)
    expect((await vault.find('acme.wd5.myworkdayjobs.com', 'CV@example.com')).id).toBe(acme.id)
    await expect(vault.find('acme.wd5.myworkdayjobs.com', 'third@example.com')).rejects.toThrow(/saved login names/u)
  })

  it('records the last use, removes a record, and serialises concurrent writes', async () => {
    const { vault } = vaultAt()
    const records = await Promise.all(['a', 'b', 'c', 'd'].map(async name => await vault.create({ host: `${name}.example.com`, username: 'cv@example.com' })))
    expect(await vault.list()).toHaveLength(4)
    await vault.touch(records[0]!.id)
    expect((await vault.find('a.example.com')).lastUsedAt).toBe('2026-11-24T12:00:00.000Z')
    expect(await vault.remove(records[1]!.id)).toBe(true)
    expect(await vault.remove('c000000000000')).toBe(false)
    expect((await vault.list()).map(view => view.host).sort()).toEqual(['a.example.com', 'c.example.com', 'd.example.com'])
  })

  it('exports the CSV layout Chrome imports, quoting what needs quoting', async () => {
    const { vault } = vaultAt()
    const record = await vault.create({ host: 'jobs.example.com', username: 'cv@example.com', label: 'Acme, Inc. "Careers"' })
    const csv = await vault.exportCsv()
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toBe('name,url,username,password,note')
    expect(lines[1]).toBe(`"Acme, Inc. ""Careers""",https://jobs.example.com/,cv@example.com,${record.password},"Acme, Inc. ""Careers""; saved by DSH 2026-11-24T12:00:00.000Z"`)
  })

  it('refuses to read or overwrite a file of another version', async () => {
    const { vault, path } = vaultAt()
    await vault.create({ host: 'jobs.example.com', username: 'cv@example.com' })
    writeFileSync(path, JSON.stringify({ version: 2, entries: [] }))
    await expect(vault.list()).rejects.toThrow(/not a version 1 credential file/u)
    await expect(vault.create({ host: 'x.example.com', username: 'cv@example.com' })).rejects.toThrow(/refusing/u)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 2, entries: [] })
  })
})
