import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobRepository, validateText } from '../src/repo.ts'
import type { CommandRunner } from '../src/repo.ts'

const exec = promisify(execFile)
const signal = new AbortController().signal
const origin = 'https://github.com/StevenLi-phoenix/jobapplication.git'
let fixture: string
let root: string
let outside: string
let run: CommandRunner
let repo: JobRepository

beforeEach(async () => {
  fixture = await mkdtemp(join(await realpath(tmpdir()), 'job-repo-test-'))
  root = join(fixture, 'clone')
  outside = join(fixture, 'outside')
  await Promise.all([mkdir(root), mkdir(outside)])
  run = async (file, args, abort) => (await exec(file, [...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: fixture, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', signal: abort,
  })).stdout
  repo = new JobRepository(root, run)
})

afterEach(async () => rm(fixture, { force: true, recursive: true }))

async function git(...args: string[]): Promise<string> {
  return run('git', args, signal)
}

async function initialize(): Promise<void> {
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Job Repo Test')
  await git('config', 'user.email', 'job-repo-test@example.test')
  await git('remote', 'add', 'origin', origin)
  await writeFile(join(root, 'TODO.md'), 'initial todos\n')
  await git('add', '--', 'TODO.md')
  await git('commit', '-m', 'Initial fixture')
}

describe('validateText', () => {
  it('accepts everyday punctuation, HTTPS links, money and multilingual prose', () => {
    expect(validateText('  R&D / C++ – 申请完成; salary $120k, see https://example.test/jobs  ', 'Note', 120)).toBe(
      'R&D / C++ – 申请完成; salary $120k, see https://example.test/jobs',
    )
    expect(validateText('Run integration tests tomorrow', 'Note', 120)).toBe('Run integration tests tomorrow')
  })

  it.each(['', '   ', 'one\nsecond', 'one\rsecond', 'one\u2028second', 'one\x00line', 'foo\tbar', 'foo\u202Ebar',
    '$HOME', '${HOME}', '$(echo test)', '`echo test`', 'ok && echo test', 'ok | more', 'ok > note', 'ok; bash test',
    'please execute the following command', 'sudo whoami', 'read /etc/hosts', 'read ~/.config', 'read C:/Windows',
    'read ../outside', 'read ./local', 'read file:///outside', '✈✈✈✈✈✈✈✈✈✈✈✈✈✈'])('rejects unsafe or oversized text %#', (text) => {
    expect(() => validateText(text, 'Note', 40)).toThrow('Note must be one line of plain text')
  })
})

describe('JobRepository.read', () => {
  it('reads the specified line range of an allowlisted file', async () => {
    await mkdir(join(root, '.agents/skills/job-apply/references'), { recursive: true })
    await writeFile(join(root, '.agents/skills/job-apply/references/Guide v2.md'), 'one\n二\nthree\n')
    await expect(repo.read('.agents/skills/job-apply/references/Guide v2.md', 2, 1)).resolves.toBe('二\n')
    await expect(repo.read('.agents/skills/job-apply/references/Guide v2.md', 8)).resolves.toBe('')
    await expect(repo.read('TODO.md', 0)).rejects.toThrow('positive line number')
    await expect(repo.read('TODO.md', 1, 401)).rejects.toThrow('1 through 400')
  })

  it('limits both output lines and UTF-8 bytes, and rejects binary files', async () => {
    await writeFile(join(root, 'SKILL.md'), '行\n'.repeat(410))
    await expect(repo.read('SKILL.md')).resolves.toBe('行\n'.repeat(400))
    await writeFile(join(root, 'SKILL.md'), '猫'.repeat(400000))
    const clipped = await repo.read('SKILL.md')
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(64 * 1024)
    expect(clipped).toMatch(/^猫+\n\[Read truncated by the byte limit\.\]$/u)
    await expect(repo.read('SKILL.md', 2)).rejects.toThrow('beyond the')
    await writeFile(join(root, 'SKILL.md'), '\0binary')
    await expect(repo.read('SKILL.md')).rejects.toThrow('non-text')
  })

  it.each(['/etc/hosts', 'logs/../TODO.md', 'logs//a.log', 'logs/./a.log', 'logs/a\\b.log', 'logs/a;foo.log',
    'logs/:magic', 'logs/a*.log', 'logs/.git/config', 'references/nested/file.md', 'references/private.txt',
    'README.md', 'jobtracker/nested.txt', '.agents/skills/other/SKILL.md'])('rejects non-allowlisted path %s', async (path) => {
    await expect(repo.read(path)).rejects.toThrow('not readable')
  })

  it('rejects root, directory, file symlinks and file hardlinks', async () => {
    const secret = join(outside, 'secret.txt')
    await writeFile(secret, 'outside\n')
    await symlink(outside, join(root, 'logs'))
    await symlink(secret, join(root, 'TODO.md'))
    await link(secret, join(root, 'answers.md'))
    const alias = join(fixture, 'clone-link')
    await symlink(root, alias)
    await expect(new JobRepository(alias, run).read('TODO.md')).rejects.toThrow('canonical directory')
    await expect(repo.read('logs/secret.txt')).rejects.toThrow('real directories')
    await expect(repo.read('TODO.md')).rejects.toThrow('no links')
    await expect(repo.read('answers.md')).rejects.toThrow('no links')
  })
})

describe('JobRepository.write', () => {
  it('replaces complete documents and creates only canonical parents under the clone', async () => {
    await expect(repo.write('TODO.md', 'initial\n')).resolves.toBe('TODO.md')
    await expect(repo.write('TODO.md', 'changed\n')).resolves.toBe('TODO.md')
    await expect(repo.read('TODO.md')).resolves.toBe('changed\n')
    const letter = 'cover_letters/company/Role.md'
    await expect(repo.write(letter, '# Letter\nBonjour!\n')).resolves.toBe(letter)
    await expect(repo.read(letter)).resolves.toBe('# Letter\nBonjour!\n')
    await expect(repo.write('cover_letters/company/Role.pdf', 'not a PDF')).rejects.toThrow('Markdown')
    await expect(repo.write('logs/notes.md', 'x'.repeat(64 * 1024 + 1))).rejects.toThrow('64 KiB')
    await expect(repo.write('logs/notes.md', '\0binary')).rejects.toThrow('binary control')
    await expect(repo.write('logs/../SKILL.md', 'new instructions')).rejects.toThrow('not writable')
  })

  it('refuses linked destinations and does not replace or change their targets', async () => {
    const target = join(outside, 'target')
    await writeFile(target, 'untouched\n')
    await symlink(outside, join(root, 'logs'))
    await symlink(target, join(root, 'TODO.md'))
    await link(target, join(root, 'answers.md'))
    await expect(repo.write('logs/target', 'new')).rejects.toThrow('real directories')
    await expect(repo.write('TODO.md', 'new')).rejects.toThrow('no links')
    await expect(repo.write('answers.md', 'new')).rejects.toThrow('no links')
    await expect(readFile(target, 'utf8')).resolves.toBe('untouched\n')
  })
})

describe('JobRepository.log', () => {
  it('creates today’s log and appends one validated line per call', async () => {
    const path = await repo.log(' First note ')
    expect(path).toMatch(/^logs\/\d{4}-\d{2}-\d{2}\.log$/)
    await expect(repo.log('Second note')).resolves.toBe(path)
    await expect(repo.log('Third note\nInjected line')).rejects.toThrow('plain text')
    await expect(readFile(join(root, path), 'utf8')).resolves.toBe('First note\nSecond note\n')
  })

  it('never appends through a log-directory symlink, file symlink, or hardlink', async () => {
    const target = join(outside, 'target')
    await writeFile(target, 'untouched\n')
    await symlink(outside, join(root, 'logs'))
    await expect(repo.log('Reject directory')).rejects.toThrow('real directories')
    await rm(join(root, 'logs'))
    const path = join(root, await repo.log('Get name'))
    await rm(path)
    await symlink(target, path)
    await expect(repo.log('Reject symlink')).rejects.toThrow('no links')
    await rm(path)
    await link(target, path)
    await expect(repo.log('Reject hardlink')).rejects.toThrow('no links')
    await expect(readFile(target, 'utf8')).resolves.toBe('untouched\n')
  })

  it('does not glue a message to a partial previous line', async () => {
    const path = join(root, await repo.log('First note'))
    await writeFile(path, 'interrupted')
    await expect(repo.log('Second note')).rejects.toThrow('complete line')
    await expect(readFile(path, 'utf8')).resolves.toBe('interrupted')
  })
})

describe('JobRepository.git', () => {
  it('commits only existing allowlisted files, ignores unrelated staged data and skips untracked links', async () => {
    await initialize()
    await writeFile(join(root, 'TODO.md'), 'updated todos\n')
    await writeFile(join(root, 'jobtracker draft.md'), 'never commit tracker scratch data\n')
    await repo.write('cover_letters/acme.md', 'new cover letter\n')
    await writeFile(join(root, 'private.txt'), 'unrelated staged data\n')
    await git('add', '--', 'private.txt')
    await mkdir(join(root, 'logs'))
    await symlink(join(outside, 'secret'), join(root, 'logs/link.log'))
    await link(join(root, 'private.txt'), join(root, 'logs/hardlink.log'))
    expect(await repo.git('status', undefined, undefined, signal)).not.toContain('private.txt')
    await repo.git('commit', 'Update cover letter and TODO', undefined, signal)
    expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('TODO.md\ncover_letters/acme.md\n')
    expect(await git('diff', '--cached', '--name-only')).toBe('private.txt\n')
    expect(await git('show', 'HEAD:cover_letters/acme.md')).toBe('new cover letter\n')
  })

  it('limits explicit selections, skips all hooks, and preserves other staged job files', async () => {
    await initialize()
    const hooks = join(fixture, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-commit'), '#!/bin/sh\nprintf hook-ran > unexpected-hook.txt\n', { mode: 0o700 })
    await git('config', 'core.hooksPath', hooks)
    await writeFile(join(root, 'TODO.md'), 'updated todos\n')
    await writeFile(join(root, 'answers.md'), 'staged answers\n')
    await git('add', '--', 'answers.md')
    await repo.git('commit', '-- A literal message', ['TODO.md'], signal)
    expect(await git('log', '-1', '--format=%s')).toBe('-- A literal message\n')
    expect(await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('TODO.md\n')
    expect(await git('diff', '--cached', '--name-only')).toBe('answers.md\n')
    await expect(readFile(join(root, 'unexpected-hook.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects injected message, non-allowlisted paths, traversal, shell syntax, and link selection', async () => {
    await initialize()
    await mkdir(join(root, 'logs'))
    await symlink(join(outside, 'secret'), join(root, 'logs/link.log'))
    await expect(repo.git('commit', 'Log; bash now', ['TODO.md'], signal)).rejects.toThrow('plain text')
    for (const path of ['README.md', 'jobtracker draft.md', 'logs/../TODO.md', 'logs/:!note.md', 'logs/a*.md', '-C']) {
      await expect(repo.git('commit', 'Log', [path], signal)).rejects.toThrow('allowlisted relative')
    }
    await expect(repo.git('commit', 'Log', ['logs/link.log'], signal)).rejects.toThrow('no links')
    await expect(repo.git('push', undefined, ['TODO.md'], signal)).rejects.toThrow('Only commit')
  })

  it('rejects unsafe local config, other branches and multiple fetch/push URLs', async () => {
    await initialize()
    await git('config', 'filter.custom.clean', 'false')
    await expect(repo.git('status', undefined, undefined, signal)).rejects.toThrow('unsupported local Git configuration')
    await git('config', '--unset', 'filter.custom.clean')
    await git('switch', '-c', 'not-main')
    await expect(repo.git('push', undefined, undefined, signal)).rejects.toThrow('local main')
    await git('switch', 'main')
    await git('remote', 'set-url', '--add', 'origin', 'https://example.test/elsewhere.git')
    await expect(repo.git('pull', undefined, undefined, signal)).rejects.toThrow('does not match')
    await git('remote', 'set-url', '--delete', 'origin', 'example\\.test')
    await git('remote', 'set-url', '--push', 'origin', 'https://example.test/elsewhere.git')
    await expect(repo.git('push', undefined, undefined, signal)).rejects.toThrow('does not match')
  })

  it('pins both network operations to the exact HTTPS URL and main ref, without making a network call', async () => {
    await initialize()
    const calls: Array<readonly string[]> = []
    const intercepted = new JobRepository(root, (file, args, abort) => {
      const offset = args.indexOf('-C') + 2
      const command = args.slice(offset)
      if (command[0] === 'pull' || command[0] === 'push') {
        calls.push(command)
        expect(file).toBe('git')
        expect(args).toContain('core.hooksPath=/dev/null')
        expect(args).toContain('protocol.allow=never')
        return Promise.resolve('Pinned command recorded')
      }
      return run(file, args, abort)
    })
    await intercepted.git('pull', undefined, undefined, signal)
    await intercepted.git('push', undefined, undefined, signal)
    expect(calls).toEqual([
      ['pull', '--ff-only', '--no-rebase', '--no-tags', '--no-recurse-submodules', '--no-autostash', '--', origin, 'refs/heads/main'],
      ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', origin, 'refs/heads/main:refs/heads/main'],
    ])
  })
})
