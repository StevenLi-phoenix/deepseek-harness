/** A finished Turn keeps every Assistant text message it contains, in order, and counts them. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { turnProcessDefinition } from '../src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'

function entry(event: SessionEvent): SessionEventLikeEntry {
  return { type: 'event', event }
}

interface Recorded {
  readonly entries: readonly SessionEventLikeEntry[]
  /** Durable settlement seq of each Assistant message, in order. */
  readonly messageSeqs: readonly number[]
  readonly turnEndSeq: number
}

/** One completed Turn whose every Step settles one Assistant text message. */
function turnWithReplies(replies: readonly string[]): Recorded {
  const entries: SessionEventLikeEntry[] = []
  const messageSeqs: number[] = []
  let seq = 1
  const at = (): SessionSeq => SessionSeq(seq++)
  entries.push(entry({ type: 'turn/start', seq: at(), time: 1_000, data: { turn: 1 } }))
  for (const [index, text] of replies.entries()) {
    const step = index + 1
    entries.push(entry({ type: 'step/start', seq: at(), time: step * 1_000, data: { turn: 1, step } }))
    const seqOfMessage = seq
    entries.push(entry({
      type: 'assistant/message', seq: at(), time: step * 1_000 + 500, surfaceOp: 'append', data: {
        turn: 1, step, stream: [],
        message: createAssistantMessage({
          source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }],
        }),
      },
    }))
    messageSeqs.push(seqOfMessage)
    entries.push(entry({ type: 'step/end', seq: at(), time: step * 1_000 + 900, data: { turn: 1, step } }))
  }
  const turnEndSeq = seq
  entries.push(entry({
    type: 'turn/end', seq: at(), time: replies.length * 1_000 + 2_000,
    data: { turn: 1, reason: { kind: 'completed' } },
  }))
  return { entries, messageSeqs, turnEndSeq }
}

function read(recorded: Recorded): ChatSnapshot {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [assistantDefinition, turnProcessDefinition, turnTailDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(recorded.entries, false)
  assembler.activateTarget('chat')
  assembler.flush()
  return assembler.snapshot('chat') as ChatSnapshot
}

function nodes(snapshot: ChatSnapshot): ChatNode[] {
  return snapshot.nodes.values().map(node => node as ChatNode)
}

/** Assistant text of each reply row in rendered order. */
function replyTexts(snapshot: ChatSnapshot): string[] {
  return snapshot.order
    .map(key => snapshot.nodes.get(key) as ChatNode | undefined)
    .filter((node): node is ChatNode<'assistant-step'> => node?.kind === 'assistant-step')
    .flatMap(node => node.data.blocks
      .flatMap(block => (block.kind === 'text' && block.text.trim() !== '' ? [block.text] : [])))
}

describe('Turn process keeps every Assistant message', () => {
  it('describes a single-message Turn as the final answer with no earlier reply', () => {
    const recorded = turnWithReplies(['only answer'])
    const snapshot = read(recorded)
    expect(replyTexts(snapshot)).toEqual(['only answer'])
    const process = nodes(snapshot).find((node): node is ChatNode<'turn-process'> => node.kind === 'turn-process')?.data
    expect(process).toMatchObject({
      turn: 1,
      answerStep: 1,
      answerAnchorSeq: recorded.messageSeqs[0],
      messageCount: 0,
      toolCallCount: 0,
    })
    const closing = nodes(snapshot).find((node): node is ChatNode<'turn-tail'> => node.kind === 'turn-tail')?.data.closing
    expect(closing?.blocks.flatMap(block => (block.kind === 'text' ? [block.text] : []))).toEqual(['only answer'])
  })

  it('keeps both messages of a two-message Turn in order', () => {
    const recorded = turnWithReplies(['first answer', 'follow-up'])
    const snapshot = read(recorded)
    expect(replyTexts(snapshot)).toEqual(['first answer', 'follow-up'])
    const process = nodes(snapshot).find((node): node is ChatNode<'turn-process'> => node.kind === 'turn-process')?.data
    expect(process).toMatchObject({
      answerStep: 2,
      answerAnchorSeq: recorded.messageSeqs[1],
      messageCount: 1,
    })
    expect(process?.processStartSeq).toBe(1)
  })

  it('keeps all three messages of a three-message Turn in order and counts the folded ones', () => {
    const recorded = turnWithReplies(['first answer', 'second answer', 'follow-up'])
    const snapshot = read(recorded)
    expect(replyTexts(snapshot)).toEqual(['first answer', 'second answer', 'follow-up'])
    const process = nodes(snapshot).find((node): node is ChatNode<'turn-process'> => node.kind === 'turn-process')?.data
    expect(process).toMatchObject({
      answerStep: 3,
      answerAnchorSeq: recorded.messageSeqs[2],
      messageCount: 2,
    })
    // Settled messages stay in the window behind the Turn end rather than collapsing away.
    const ordered = snapshot.order
      .map(key => snapshot.nodes.get(key) as ChatNode | undefined)
      .filter(node => node?.kind === 'assistant-step')
      .map(node => node?.location.kind === 'step' ? node.location.step.step : null)
    expect(ordered).toEqual([1, 2, 3])
  })
})
