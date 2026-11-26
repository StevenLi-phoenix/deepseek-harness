/**
 * Tests for the shared escalation vocabulary and choreography: the strictly-
 * wider ladder, the argument-pairing validation, the model-facing markers, and
 * {@link approveEscalation}'s ordered fail-closed sequence. Both enforcing tool
 * families (`dsh-tool-bash`, `dsh-tool-fs`) delegate here, so the ordering and
 * verbatim texts are pinned once, next to the vocabulary that owns them.
 */

import { describe, expect, it } from 'vitest'
import {
  ESCALATION_TARGETS,
  SandboxEscalationError,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  readEscalationArgs,
  sandboxPermissionsDescription,
  validateEscalationArgs,
  widensSandbox,
} from '@deepseek-ai/dsh-sandbox'
import type { EscalationApprover, EscalationOutcome, SandboxEscalationErrorCode } from '@deepseek-ai/dsh-sandbox'

/** The structured identity a failed escalation records on `tool/result`. */
const escalationError = (code: SandboxEscalationErrorCode): unknown => expect.objectContaining({ name: 'SandboxEscalationError', code })

/** The synchronous failure `run` throws. */
function thrown(run: () => void): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected a throw')
}

describe('the strictly-wider ladder', () => {
  it('read-only escalates to either wider mode; workspace-write only to full access', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access'])
    expect(WIDER_MODES['danger-full-access']).toBeUndefined()
  })

  it('the target enum is the closed set every session could escalate TO (read-only is the floor)', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
  })
})

describe('validateEscalationArgs', () => {
  it('accepts neither field, or both with a non-empty justification', () => {
    expect(() => { validateEscalationArgs(undefined, undefined) }).not.toThrow()
    expect(() => { validateEscalationArgs('workspace-write', 'because the workspace needs it') }).not.toThrow()
  })

  it('rejects one field without the other, and a blank justification', () => {
    expect(() => { validateEscalationArgs('workspace-write', undefined) }).toThrow(/requires a justification/)
    expect(() => { validateEscalationArgs(undefined, 'orphan reason') }).toThrow(/only valid together with sandbox_permissions/)
    expect(() => { validateEscalationArgs('workspace-write', '   ') }).toThrow(/non-empty sentence/)
    for (const [mode, justification] of [['workspace-write', undefined], [undefined, 'orphan reason'], ['workspace-write', '   ']] as const) {
      const error = thrown(() => { validateEscalationArgs(mode, justification) })
      expect(error).toBeInstanceOf(SandboxEscalationError)
      expect(error).toEqual(escalationError('SANDBOX_ESCALATION_INVALID_ARGUMENT'))
    }
  })
})

describe('widensSandbox and readEscalationArgs', () => {
  it('only a strictly wider known mode widens; a repeat or a narrower mode does not', () => {
    expect(widensSandbox('workspace-write', 'read-only')).toBe(true)
    expect(widensSandbox('danger-full-access', 'workspace-write')).toBe(true)
    expect(widensSandbox('workspace-write', 'workspace-write')).toBe(false)
    expect(widensSandbox('workspace-write', 'danger-full-access')).toBe(false)
    expect(widensSandbox('read-only', 'danger-full-access')).toBe(false)
  })

  it('an unknown requested or current mode fails closed', () => {
    expect(thrown(() => widensSandbox('unknown-mode', 'read-only'))).toEqual(escalationError('SANDBOX_ESCALATION_INVALID_ARGUMENT'))
    expect(() => widensSandbox('unknown-mode', 'read-only'))
      .toThrow('sandbox escalation to "unknown-mode" names no sandbox mode; send one of "workspace-write", "danger-full-access" or leave both fields out')
    expect(() => widensSandbox('workspace-write', 'unknown-mode' as never))
      .toThrow('this call\'s current mode "unknown-mode" is not a sandbox mode')
  })

  it('the strict-schema filler (a repeated or narrower mode, any reason) runs under the effective mode', () => {
    // DSH job-apply subagents under danger-full-access sent "workspace-write" with "" on bash and write calls.
    for (const justification of [undefined, '', ' ', 'a reason']) {
      expect(readEscalationArgs('workspace-write', justification, 'danger-full-access')).toBeUndefined()
      expect(readEscalationArgs('danger-full-access', justification, 'danger-full-access')).toBeUndefined()
    }
    expect(readEscalationArgs(undefined, undefined, 'workspace-write')).toBeUndefined()
    expect(readEscalationArgs(undefined, '  ', 'workspace-write')).toBeUndefined()
  })

  it('a widening request needs a non-empty reason, and a reason alone is unpaired', () => {
    expect(readEscalationArgs('danger-full-access', 'needs the network', 'workspace-write'))
      .toEqual({ mode: 'danger-full-access', justification: 'needs the network' })
    expect(() => readEscalationArgs('danger-full-access', '', 'workspace-write')).toThrow(/non-empty sentence/)
    expect(() => readEscalationArgs('danger-full-access', undefined, 'workspace-write')).toThrow(/requires a justification/)
    expect(() => readEscalationArgs(undefined, 'orphan reason', 'workspace-write')).toThrow(/only valid together with sandbox_permissions/)
  })

  it('without a confining mode the pairing rules still apply', () => {
    expect(readEscalationArgs('workspace-write', 'a reason', undefined)).toEqual({ mode: 'workspace-write', justification: 'a reason' })
    expect(() => readEscalationArgs('workspace-write', '', undefined)).toThrow(/non-empty sentence/)
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('the sandbox_permissions description names the family subject', () => {
    expect(sandboxPermissionsDescription('command')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.')
    expect(sandboxPermissionsDescription('operation')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.')
  })

  it('the hint marker names the family subject', () => {
    expect(escalationHintMarker('command')).toContain('retry this exact command once with sandbox_permissions')
    expect(escalationHintMarker('operation')).toContain('retry this exact operation once with sandbox_permissions')
  })
})

describe('approveEscalation', () => {
  const req = (over: Partial<Parameters<typeof approveEscalation>[0]> = {}) => ({
    requestedMode: 'workspace-write',
    justification: 'the user asked to write in the workspace',
    effectiveMode: 'read-only' as const,
    subject: 'command',
    ...over,
  })
  /** An approver that records the request and returns a fixed outcome. */
  const approver = (outcome: EscalationOutcome, sink?: (req: unknown) => void): EscalationApprover => ({
    request: async (request) => { sink?.(request); return outcome },
  })
  const ingredients = (over: Partial<Parameters<typeof approveEscalation>[1]> = {}) => ({
    approver: approver('allowed-once'),
    agent: {},
    callId: 'call-1',
    toolName: 'bash',
    ...over,
  })

  it('grants: returns the requested mode, asking through the approver with the audit reason', async () => {
    const seen: { reason?: string }[] = []
    const granted = await approveEscalation(req(), ingredients({ approver: approver('allowed-once', r => seen.push(r as { reason?: string })) }))
    expect(granted).toBe('workspace-write')
    expect(seen[0]?.reason).toBe('escalate sandbox to workspace-write: the user asked to write in the workspace')
    expect(seen[0]).toMatchObject({
      displayReason: {
        en: 'Allow this operation with workspace-write permissions: the user asked to write in the workspace',
        zh: '允许本次操作使用 workspace-write 权限：the user asked to write in the workspace',
        ja: 'workspace-write 権限でこの操作を許可します：the user asked to write in the workspace',
      },
    })
  })

  it.each(ESCALATION_TARGETS)('repeating %s succeeds without asking for approval', async (mode) => {
    const seen: unknown[] = []
    const request = req({ requestedMode: mode, effectiveMode: mode })
    await expect(approveEscalation(request, ingredients({ approver: approver('rejected', r => seen.push(r)) })))
      .resolves.toBe(mode)
    expect(seen).toEqual([])
    await expect(approveEscalation(request, ingredients({ approver: undefined, agent: undefined })))
      .resolves.toBe(mode)
  })

  it('a narrower target returns the effective mode and an unsupported one fails closed, neither asking', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    await expect(approveEscalation(req({ requestedMode: 'read-only', effectiveMode: 'workspace-write' }), spy))
      .resolves.toBe('workspace-write')
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' }), spy))
      .resolves.toBe('danger-full-access')
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' }), ingredients({ approver: undefined, agent: undefined })))
      .resolves.toBe('danger-full-access')
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toThrow(/names no sandbox mode/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_INVALID_ARGUMENT'))
    expect(seen).toEqual([])
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toThrow(/no approval service is composed/)
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toThrow(/no agent to route it through/)
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
  })

  it('maps each non-grant outcome to its distinct verbatim text (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toThrow('the user rejected escalating this operation to "workspace-write"; it stays denied, so stop and explain instead of working around it')
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toThrow('approval for escalating to "workspace-write" was cancelled')
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toThrow('no approval channel is available')
  })

  it('codes each non-grant outcome', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('rejected') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_REJECTED'))
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_CANCELLED'))
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
  })

  it('a cancelled approval for an aborted call rethrows the call\'s cancellation', async () => {
    const controller = new AbortController()
    const reason = new DOMException('caller stopped', 'AbortError')
    controller.abort(reason)
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled'), signal: controller.signal })))
      .rejects.toBe(reason)
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
