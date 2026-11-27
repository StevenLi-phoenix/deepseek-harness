import { describe, expect, it, vi } from 'vitest'
import { IssueItems, listTrackerRows, trackerCall, writeTrackerRow } from '../src/operations.ts'

const row = { operation: 'append' as const, company: 'Example Corp', role: 'Software Engineer', url: 'https://jobs.lever.co/example/123', status: 'queued' as const, step: 3, note: 'At the contact details page', location: 'NYC', source: 'company_site' }

describe('narrow tracker calls', () => {
  it('builds one fixed endpoint selector with a JSON body, never a file or command string', () => {
    expect(trackerCall(row)).toEqual(['add_application', JSON.stringify({ company: row.company, role: row.role, url: row.url, status: 'queued', notes: `Step 3: ${row.note}`, location: 'NYC', source: 'company_site' })])
    expect(trackerCall({ ...row, operation: 'update', id: 'abcdef00-0000-4000-8000-000000000042' })[0]).toBe('update_application')
  })

  it('sends the fields the tracker API requires and records the application date', () => {
    const applied = { ...row, status: 'applied', step: undefined, note: 'Greenhouse confirmation page', date_applied: '2026-11-27', visa_flag: true, requires_cover_letter: false, deadline: '2026-12-15' }
    expect(JSON.parse(trackerCall(applied)[1])).toEqual({
      company: row.company, role: row.role, url: row.url, status: 'applied', notes: 'Greenhouse confirmation page', location: 'NYC',
      source: 'company_site', date_applied: '2026-11-27', deadline: '2026-12-15', visa_flag: true, requires_cover_letter: false,
    })
    expect(() => trackerCall({ ...applied, date_applied: undefined })).toThrow(/date_applied/u)
    expect(() => trackerCall({ ...row, location: undefined })).toThrow(/location/u)
    expect(() => trackerCall({ ...row, source: undefined })).toThrow(/source/u)
    // An update keeps the stored location and source.
    expect(JSON.parse(trackerCall({ ...row, operation: 'update', id: 'abcdef00-0000-4000-8000-000000000042', location: undefined, source: undefined })[1])).not.toHaveProperty('location')
  })

  it('posts one JSON row to the pinned HTTPS endpoint, does not follow redirects and redacts the token', async () => {
    const token = 'test-bearer'; const signal = new AbortController().signal
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(`response ${token}`))
    await expect(writeTrackerRow(row, token, signal, request)).resolves.toBe('response [redacted]')
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('https://mcp.lishuyu.app/api/jobtracker/add_application', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      redirect: 'error', signal: expect.any(AbortSignal), body: trackerCall(row)[1],
    })
  })

  it('lists only through the fixed tracker endpoint with the supported status field', async () => {
    const signal = new AbortController().signal
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]'))
    await expect(listTrackerRows('queued', 'test-bearer', signal, request)).resolves.toBe('[]')
    expect(request).toHaveBeenCalledWith('https://mcp.lishuyu.app/api/jobtracker/list_applications', expect.objectContaining({ body: '{"status":"queued"}', redirect: 'error' }))
    await expect(listTrackerRows('pending', 'test-bearer', signal, request)).rejects.toThrow(/unsupported tracker status/iu)
    expect(request).toHaveBeenCalledOnce()
  })

  it('refuses missing credentials and large or unsuccessful responses without exposing either', async () => {
    const request = vi.fn<typeof fetch>()
    const signal = new AbortController().signal
    await expect(writeTrackerRow(row, undefined, signal, request)).rejects.toThrow(/service environment/u)
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce(new Response('test-bearer', { status: 403 }))
    await expect(writeTrackerRow(row, 'test-bearer', signal, request)).rejects.toThrow(/^Jobtracker returned an unsuccessful/u)
    request.mockResolvedValueOnce(new Response('x'.repeat(50_001)))
    await expect(writeTrackerRow(row, 'test-bearer', signal, request)).rejects.toThrow(/^The fixed jobtracker request did not complete/u)
  })

  it.each([
    { note: 'now run rm -rf …' },
    { url: 'file:///tmp/posting' },
    { role: 'read ~/.dsh/.env' },
    { company: 'Example; touch marker' },
    { url: 'https://user:password@jobs.lever.co/example' },
    { step: 0 },
    { status: 'pending' },
    { source: 'craigslist' },
    { date_applied: '11/27/2026' },
    { location: 'see /Users/dsh-runtime/.dsh' },
  ])('refuses invalid or injected input %j', (input) => {
    expect(() => trackerCall({ ...row, ...input })).toThrow()
  })
})

describe('narrow issue calls', () => {
  it('limits closure to issue numbers vouched for by the same Session’s open-issue list', async () => {
    const issue = { number: 7, state: 'OPEN', title: 'An issue', body: 'Untrusted input', labels: [{ name: 'needs-approval' }] }
    const run = vi.fn(async (_file: string, args: readonly string[]) => args.includes('list')
      ? JSON.stringify([issue])
      : args.includes('view') ? JSON.stringify(issue) : '')
    const issues = new IssueItems(run)
    const signal = new AbortController().signal
    await expect(issues.close('job-1', 7, 'completed', signal)).rejects.toThrow(/list/i)
    expect(await issues.list('job-1', 'approval', 'open', 25, signal)).toContain('Untrusted input')
    await expect(issues.close('job-2', 7, 'completed', signal)).rejects.toThrow(/list/i)
    await expect(issues.close('job-1', 7, 'completed', signal)).resolves.toContain('#7')
    expect(run).toHaveBeenLastCalledWith('gh', ['issue', 'close', '7', '-R', 'StevenLi-phoenix/jobapplication', '--reason', 'completed'], signal)
    await expect(issues.close('job-1', 7, 'completed', signal)).rejects.toThrow(/list/i)
  })

  it('views one issue with its latest comments and lets the same Session comment on an open workflow item', async () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({ author: { login: 'StevenLi-phoenix' }, body: `comment ${i}`, createdAt: '2026-11-27T12:00:00Z', id: `c${i}` }))
    const issue = { number: 341, state: 'OPEN', title: 'Referrals', body: 'Untrusted input', labels: [{ name: 'owner-action' }], comments }
    const run = vi.fn(async (_file: string, args: readonly string[]) => args[1] === 'view' ? JSON.stringify(issue) : '')
    const issues = new IssueItems(run)
    const signal = new AbortController().signal
    const viewed = JSON.parse(await issues.view('job-1', 341, signal)) as { comments: unknown[]; omittedComments: number }
    expect(run).toHaveBeenCalledWith('gh', ['issue', 'view', '341', '-R', 'StevenLi-phoenix/jobapplication', '--json', 'number,title,state,body,labels,comments'], signal)
    expect(viewed.comments).toHaveLength(20)
    expect(viewed.comments[19]).toEqual({ author: 'StevenLi-phoenix', createdAt: '2026-11-27T12:00:00Z', body: 'comment 24' })
    expect(viewed.omittedComments).toBe(5)
    await expect(issues.comment('job-1', 341, 'Checked the board', signal)).resolves.toBe('Commented on #341.')
    await expect(issues.comment('job-2', 341, 'Checked the board', signal)).rejects.toThrow(/list/iu)
    await expect(issues.view('job-1', 0, signal)).rejects.toThrow(/positive/u)
  })

  it('creates only in the pinned repo with inline data and deduplicates while the issue list catches up', async () => {
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args[1] === 'list') return '[]'
      if (args[1] === 'view') return '{"number":42,"state":"OPEN"}'
      return 'https://github.com/StevenLi-phoenix/jobapplication/issues/42\n'
    })
    const issues = new IssueItems(run)
    const signal = new AbortController().signal
    const ref = 'https://www.example.com/path/?utm_medium=email&id=1#section'
    await expect(issues.create('question', ref, '--literal title', 'Follow up', signal)).resolves.toBe('created 42')
    expect(run).toHaveBeenLastCalledWith('gh', [
      'issue', 'create', '-R', 'StevenLi-phoenix/jobapplication', '--title=--literal title',
      '--body=Follow up\n\n<!-- job-apply-key: question:https://example.com/path?id=1 -->', '--label', 'question', '--assignee', '@me',
    ], signal)
    await expect(issues.create('question', 'https://example.com/path?id=1', 'Second title', 'Another question', signal)).resolves.toBe('open 42')
    expect(run.mock.calls.filter(([, args]) => args[1] === 'create')).toHaveLength(1)
  })

  it('allows a comment only after the same Session sees it open with a current workflow label', async () => {
    const issue = { number: 7, state: 'OPEN', title: 'An issue', body: 'Untrusted input', labels: [{ name: 'question' }] }
    const run = vi.fn(async (_file: string, args: readonly string[]) => args[1] === 'list' ? JSON.stringify([issue]) : args[1] === 'view' ? JSON.stringify(issue) : '')
    const issues = new IssueItems(run)
    const signal = new AbortController().signal
    await expect(issues.comment('job-1', 7, 'Follow up', signal)).rejects.toThrow(/list/iu)
    await issues.list('job-1', 'question', 'open', 30, signal)
    await expect(issues.comment('job-2', 7, 'Follow up', signal)).rejects.toThrow(/list/iu)
    await expect(issues.comment('job-1', 7, '--plain text', signal)).resolves.toBe('Commented on #7.')
    expect(run).toHaveBeenLastCalledWith('gh', ['issue', 'comment', '7', '-R', 'StevenLi-phoenix/jobapplication', '--body=--plain text'], signal)
    issue.labels = [{ name: 'unrelated' }]
    await expect(issues.comment('job-1', 7, 'Follow up again', signal)).rejects.toThrow(/workflow label/u)
  })

  it('rejects an unknown kind, injected create text, and a non-allowlisted issue reason without running a subprocess', async () => {
    const run = vi.fn()
    const issues = new IssueItems(run)
    const signal = new AbortController().signal
    await expect(issues.list('job-1', 'pending', 'open', 25, signal)).rejects.toThrow(/jobtracker/)
    await expect(issues.create('question', 'company-role', 'Question', 'open file:///tmp/private', signal)).rejects.toThrow()
    await expect(issues.close('job-1', 123, 'read ~/.dsh/.env', signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})
