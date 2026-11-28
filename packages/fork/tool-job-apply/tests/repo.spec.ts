import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { present } from '../src/operations.ts'
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
  it.each([
    '.agents/skills/job-apply/SKILL.md', '.agents/skills/job-apply/references/Guide v2.md',
    'answers.md', 'TODO.md', 'logs/nested/history.log', 'cover_letters/nested/Role.md', 'private/resume.txt',
    'SKILL.md', 'jobtracker draft.md', 'references/Guide.md',
  ])('reads allowlisted path %s', async (path) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, 'fixture text\n')
    await expect(repo.read(path)).resolves.toBe('fixture text\n')
  })

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
    'README.md', 'jobtracker/nested.txt', '.agents/skills/other/SKILL.md', 'private/resume.pdf',
    'private/resume.txt.bak', 'private/Resume.txt', 'private/nested/resume.txt', '.git/config'])('rejects non-allowlisted path %s', async (path) => {
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

describe('JobRepository targeted edits', () => {
  it.each(['TODO.md', 'answers.md', 'logs/nested/history.log', 'cover_letters/nested/Role.md'])('appends and replaces on %s', async (path) => {
    await expect(repo.append(path, 'first line\nsecond line')).resolves.toBe(path)
    await expect(repo.append(path, 'third line\n')).resolves.toBe(path)
    await expect(repo.replace(path, 'second line\nthird line', '$& replaced')).resolves.toBe(path)
    await expect(readFile(join(root, path), 'utf8')).resolves.toBe('first line\n$& replaced\n')
    await expect(repo.replace(path, '$& replaced\n', '')).resolves.toBe(path)
    await expect(readFile(join(root, path), 'utf8')).resolves.toBe('first line\n')
  })

  it('preserves surrounding bytes and mode while editing a file larger than the whole-file write limit', async () => {
    const path = 'TODO.md'
    const file = join(root, path)
    const initial = `\uFEFF${'猫\r\n'.repeat(16000)}last item`
    await writeFile(file, initial, { mode: 0o640 })
    await expect(repo.append(path, 'new item')).resolves.toBe(path)
    await expect(repo.replace(path, 'last item', 'edited item')).resolves.toBe(path)
    await expect(readFile(file, 'utf8')).resolves.toBe(`${initial.slice(0, -9)}edited item\nnew item\n`)
    expect((await stat(file)).mode & 0o777).toBe(0o640)
  })

  it.each([
    ['none here', 'missing', 'found none'],
    ['one then one', 'one', 'found more than one'],
    ['aaaa', 'aaa', 'found more than one'],
    ['has text', '', 'nonempty oldText'],
  ])('refuses a non-unique or empty exact match %# without changing the file', async (initial, oldText, message) => {
    const file = join(root, 'TODO.md')
    await writeFile(file, initial)
    await expect(repo.replace('TODO.md', oldText, 'new')).rejects.toThrow(message)
    await expect(readFile(file, 'utf8')).resolves.toBe(initial)
    expect(await readdir(root)).toEqual(['TODO.md'])
  })

  it('refuses to replace a missing file without creating it or its parents', async () => {
    await expect(repo.replace('TODO.md', 'old', 'new')).rejects.toThrow('existing file')
    await expect(repo.replace('logs/new/history.log', 'old', 'new')).rejects.toThrow('real directories')
    expect(await readdir(root)).toEqual([])
  })

  it('limits each supplied text in UTF-8 bytes and refuses non-text input without writing', async () => {
    const file = join(root, 'answers.md')
    const fitting = `${'猫'.repeat(21845)}a`
    const oversized = `${fitting}a`
    await writeFile(file, 'old\n')
    await expect(repo.append('answers.md', oversized)).rejects.toThrow('64 KiB')
    await expect(repo.replace('answers.md', oversized, 'new')).rejects.toThrow('64 KiB')
    await expect(repo.replace('answers.md', 'old', oversized)).rejects.toThrow('64 KiB')
    await expect(repo.append('answers.md', '')).rejects.toThrow('nonempty text')
    await expect(repo.append('answers.md', '\0')).rejects.toThrow('binary control')
    await expect(repo.replace('answers.md', '\0', 'new')).rejects.toThrow('binary control')
    await expect(repo.replace('answers.md', 'old', '\uD800')).rejects.toThrow('UTF-8 text')
    await expect(readFile(file, 'utf8')).resolves.toBe('old\n')
    await expect(repo.append('answers.md', fitting)).resolves.toBe('answers.md')
    await expect(repo.replace('answers.md', fitting, 'new')).resolves.toBe('answers.md')
  })

  it('refuses oversized or non-text existing files, and caps the resulting file', async () => {
    const path = 'TODO.md'
    const file = join(root, path)
    const cap = 1024 * 1024
    const fitting = `${'a'.repeat(cap - 3)}\nb\n`
    await writeFile(file, fitting)
    await expect(repo.append(path, 'new')).rejects.toThrow('1 MiB')
    await expect(repo.replace(path, '\nb\n', '\nnew\n')).rejects.toThrow('1 MiB')
    await expect(readFile(file, 'utf8')).resolves.toBe(fitting)
    for (const invalid of [Buffer.alloc(cap + 1, 0x61), Buffer.from([0xff]), Buffer.from('first\0next')]) {
      await writeFile(file, invalid)
      await expect(repo.append(path, 'new')).rejects.toThrow(/1 MiB|UTF-8 text/u)
      await expect(repo.replace(path, 'first', 'new')).rejects.toThrow(/1 MiB|UTF-8 text/u)
      await expect(readFile(file)).resolves.toEqual(invalid)
    }
    expect(await readdir(root)).toEqual(['TODO.md'])
  })

  it.each([
    'SKILL.md', '.agents/skills/job-apply/SKILL.md', 'references/Guide.md', 'jobtracker draft.md',
    'private/resume.txt', 'private/resume.pdf', 'README.md', '.git/config', '/tmp/elsewhere',
    'logs/../TODO.md', 'logs/.git/config', 'cover_letters/Role.pdf', 'cover_letters/Role.docx',
  ])('refuses edits outside writable text paths: %s', async (path) => {
    await expect(repo.write(path, 'new')).rejects.toThrow(/not writable|Markdown/u)
    await expect(repo.append(path, 'new')).rejects.toThrow(/not writable|Markdown/u)
    await expect(repo.replace(path, 'old', 'new')).rejects.toThrow(/not writable|Markdown/u)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses linked or non-regular edit targets without changing other files', async () => {
    const target = join(outside, 'target')
    await writeFile(target, 'untouched\n')
    await symlink(outside, join(root, 'logs'))
    await symlink(target, join(root, 'TODO.md'))
    await link(target, join(root, 'answers.md'))
    await mkdir(join(root, 'cover_letters', 'directory.md'), { recursive: true })
    for (const path of ['logs/target', 'TODO.md', 'answers.md', 'cover_letters/directory.md']) {
      await expect(repo.append(path, 'new')).rejects.toThrow(/real directories|no links/u)
      await expect(repo.replace(path, 'untouched', 'new')).rejects.toThrow(/real directories|no links/u)
    }
    await expect(readFile(target, 'utf8')).resolves.toBe('untouched\n')
  })

  it('does not lose an acknowledged edit when two mounts edit the same file', async () => {
    const path = 'TODO.md'
    const file = join(root, path)
    await writeFile(file, 'initial\n')
    const other = new JobRepository(root, run)
    const results = await Promise.allSettled([repo.append(path, 'first'), other.append(path, 'second')])
    const final = await readFile(file, 'utf8')
    const messages = ['first', 'second']
    expect(results.some(result => result.status === 'fulfilled')).toBe(true)
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') expect(final).toContain(`${messages[index]}\n`)
      else expect(result.reason).toEqual(new Error('Repository output changed while writing. Read it again before retrying.'))
    }
    expect(await readdir(root)).toEqual(['TODO.md'])
  })
})

describe('present', () => {
  it('drops the fillers a strict-schema provider sends for unused fields', () => {
    expect(present({ operation: 'list', status: 'queued', id: '', step: 0, paths: [], visa_flag: false, note: null }))
      .toEqual({ operation: 'list', status: 'queued', visa_flag: false })
    // An update leaves stored flags alone unless the call sets one.
    expect(present({ visa_flag: false, requires_cover_letter: true }, false)).toEqual({ requires_cover_letter: true })
  })
})

describe('job_repo tool', () => {
  it.each(['apply', 'inbox', 'lead'] as const)('exposes scoped edits in %s without widening runbook access', async (mode) => {
    const ctx = new Context()
    const batchRunbook = join(outside, 'job-apply-batch.md')
    await writeFile(batchRunbook, 'runbook fixture\n')
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const { agent } = await ctx.agents.create({
        sessionId: SessionId(`job-${mode}`), agentOptions: { provider: 'mock', model: 'mock' },
        setup: async (scope) => { await scope.plugin(JobTools, { root, mode, batchRunbook }) },
      })
      const call = async (args: Record<string, unknown>) => (await ctx.tools.execute({
        agent, signal, calls: [{ type: 'tool-call', id: ToolCallId('job-repo-call'), name: 'job_repo', arguments: JSON.stringify(args) }],
      })).results[0]?.result
      // Codex sends every declared field, filling the unused ones; each operation must read only its own.
      const filled = { path: '', text: '', oldText: '', start: 1, limit: 250, message: '', paths: [] }
      expect(await call({ ...filled, operation: 'append', path: 'TODO.md', text: 'first' })).toMatchObject({ isError: false })
      expect(await call({ ...filled, operation: 'replace', path: 'TODO.md', oldText: 'first', text: 'second' })).toMatchObject({ isError: false })
      expect(await call({ ...filled, operation: 'replace', path: 'TODO.md', text: 'bad' })).toMatchObject({ isError: true })
      expect(await call({ ...filled, operation: 'append', path: batchRunbook, text: 'bad' })).toMatchObject({ isError: true })
      expect(await call({ ...filled, operation: 'read', path: 'TODO.md', start: 0, limit: 0 })).toMatchObject({ isError: false })
      const runbook = await call({ ...filled, operation: 'read_runbook' })
      expect(runbook).toMatchObject({ isError: mode !== 'lead' })
      if (mode === 'lead') expect(JSON.stringify(runbook)).toContain('runbook fixture')
      // write_runbook is lead-only; elsewhere the call fails and the runbook stays.
      if (mode !== 'lead') expect(await call({ ...filled, operation: 'write_runbook', text: 'bad' })).toMatchObject({ isError: true })
      await expect(readFile(join(root, 'TODO.md'), 'utf8')).resolves.toBe('second\n')
      await expect(readFile(batchRunbook, 'utf8')).resolves.toBe('runbook fixture\n')
      // A replacement of '' removes the match.
      expect(await call({ ...filled, operation: 'replace', path: 'TODO.md', oldText: 'second\n', text: '' })).toMatchObject({ isError: false })
      await expect(readFile(join(root, 'TODO.md'), 'utf8')).resolves.toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
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
    // Tracking of another local branch, as a follow-up PR branch leaves it, is accepted.
    await git('config', 'branch.followup/2026-11-25-hpe.remote', 'origin')
    await git('config', 'branch.followup/2026-11-25-hpe.merge', 'refs/heads/followup/2026-11-25-hpe')
    await expect(repo.git('status', undefined, undefined, signal)).resolves.toBeTypeOf('string')
    await git('config', 'branch.followup/2026-11-25-hpe.pushRemote', 'origin')
    await expect(repo.git('status', undefined, undefined, signal)).rejects.toThrow('unsupported local Git configuration')
    await git('config', '--unset', 'branch.followup/2026-11-25-hpe.pushRemote')
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
      ['pull', '--rebase', '--autostash', '--no-tags', '--no-recurse-submodules', '--', origin, 'refs/heads/main'],
      ['push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', origin, 'refs/heads/main:refs/heads/main'],
    ])
  })

  it('aborts a failed rebase pull so the clone never stays mid-rebase, and still reports the failure', async () => {
    await initialize()
    const calls: Array<readonly string[]> = []
    const intercepted = new JobRepository(root, (file, args, abort) => {
      const command = args.slice(args.indexOf('-C') + 2)
      if (command[0] === 'pull' || command[0] === 'rebase') {
        calls.push(command)
        return command[0] === 'pull' ? Promise.reject(new Error('The fixed git command did not succeed (1)')) : Promise.resolve('')
      }
      return run(file, args, abort)
    })
    await expect(intercepted.git('pull', undefined, undefined, signal)).rejects.toThrow('did not succeed')
    expect(calls).toEqual([
      ['pull', '--rebase', '--autostash', '--no-tags', '--no-recurse-submodules', '--', origin, 'refs/heads/main'],
      ['rebase', '--abort'],
    ])
  })
})
