#!/usr/bin/env node
// Fails when a tracked file's path or text names the owner by initials or by account name: this repository is public.
// The one form allowed is the owner's domain: the `.app` domain itself, its subdomains, and the reverse-DNS labels
// (`app.<account>.<service>`) launchd uses. A word that only contains the initials' letters inside it (`falsy`) and
// lockfile integrity hashes do not count; a camelCase part (`fooLxyBar` with the initials) does. Both names are built
// from character codes so this file passes its own check. Exit 0 = clean, 1 = a name was found, 2 = usage error.
//   usage: check-owner-names.mjs            every file `git ls-files` lists, plus the paths themselves
//          check-owner-names.mjs --cached   only the files the index adds or changes, as staged (pre-commit)
//          check-owner-names.mjs --self-test
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INITIALS = String.fromCharCode(108, 115, 121)
const ACCOUNT = String.fromCharCode(108, 105, 115, 104, 117, 121, 117)
const [FIRST, ...REST] = INITIALS.split('').map(c => `[${c}${c.toUpperCase()}]`)
// The initials at the start of a word in any case, or as a capitalized camelCase part.
const INITIALS_WORD = new RegExp(`(?<![A-Za-z0-9])${FIRST}${REST.join('')}|(?<=[a-z0-9])${INITIALS[0].toUpperCase()}${REST.join('')}`, 'gu')
// The account name anywhere, in any case, except as the domain or a reverse-DNS label of it.
const ACCOUNT_NAME = new RegExp(`(?<!app\\.)${ACCOUNT}(?!\\.app(?![A-Za-z0-9-]))`, 'giu')
const INTEGRITY = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+=*/gu

/**
 * Every place a line names the owner.
 * @param {string} line - one line of text.
 * @returns {string[]} the matched spellings, in order.
 */
export function ownerNames(line) {
  const text = line.replace(INTEGRITY, '')
  return [...text.matchAll(INITIALS_WORD), ...text.matchAll(ACCOUNT_NAME)].map(m => m[0])
    .filter((value, index, all) => all.indexOf(value) === index)
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 1 << 30, ...options })
}

function scan(files, read) {
  const hits = []
  for (const file of files) {
    for (const name of ownerNames(file)) hits.push(`${file}: path names ${JSON.stringify(name)}`)
    const bytes = read(file)
    if (bytes === undefined || bytes.subarray(0, 8000).includes(0)) continue
    bytes.toString('utf8').split('\n').forEach((line, index) => {
      const names = ownerNames(line)
      if (names.length > 0) hits.push(`${file}:${index + 1}: ${names.map(name => JSON.stringify(name)).join(', ')}: ${line.trim().slice(0, 160)}`)
    })
  }
  return hits
}

function selfTest() {
  const flagged = [
    `@deepseek-ai/dsh-${INITIALS}-wechat`, `${INITIALS.toUpperCase()}_INGEST_TOKEN`, `POST /hooks/${INITIALS}`, `${INITIALS}SubagentActivity`,
    `the ${INITIALS}/deploy dir`, `X_${INITIALS.toUpperCase()}`, `fooL${INITIALS.slice(1)}Bar`, `/Users/${ACCOUNT}/.env`, `${ACCOUNT.toUpperCase()}`,
    `${ACCOUNT}.application`, `${ACCOUNT}-app`,
  ]
  const clean = [
    'a falsy value', 'FALSY', 'palsy', `https://api.${ACCOUNT}.app/courses`, `${ACCOUNT}.app`, `system/app.${ACCOUNT}.dsh-events`,
    `integrity: sha512-312Id396EbJdvRONlngUx0NydfrIQ5${INITIALS[0]}${INITIALS.slice(1).toUpperCase()}u0zn+${INITIALS}/q==`, '',
  ]
  const wrong = [
    ...flagged.filter(line => ownerNames(line).length === 0).map(line => `not flagged: ${line}`),
    ...clean.filter(line => ownerNames(line).length > 0).map(line => `flagged: ${line} -> ${ownerNames(line).join(', ')}`),
  ]
  if (wrong.length > 0) {
    console.error(`check-owner-names: self-test FAILED\n  ${wrong.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`check-owner-names: self-test passed (${flagged.length} flagged, ${clean.length} clean)`)
}

const args = process.argv.slice(2)
if (args.some(arg => !['--cached', '--self-test'].includes(arg))) {
  console.error('usage: check-owner-names.mjs [--cached | --self-test]')
  process.exit(2)
}
if (args.includes('--self-test')) {
  selfTest()
  process.exit(0)
}
const root = git(['-C', dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel']).trim()
const cached = args.includes('--cached')
const files = (cached
  ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root })
  : git(['ls-files', '-z'], { cwd: root })).split('\0').filter(Boolean)
const hits = scan(files, file => {
  try {
    return cached ? git(['show', `:${file}`], { cwd: root, encoding: 'buffer' }) : readFileSync(join(root, file))
  } catch {
    // A path git lists but the tree lacks (a deleted, unstaged file; a submodule) has no text to check.
    return undefined
  }
})
if (hits.length > 0) {
  console.error(`check-owner-names: ${hits.length} place(s) name the owner (the repository is public):\n  ${hits.slice(0, 200).join('\n  ')}`)
  process.exit(1)
}
console.log(`check-owner-names: ${files.length} file(s) clean`)
