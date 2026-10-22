/**
 * `wechat_send_file`: the agent sends a local file to the owner on WeChat. The
 * recipient, the reply window, and every check live in the WeChat channel
 * (`WechatChannel.sendFile`); the tool only passes the path and returns what
 * happened, so nothing here depends on what the model writes in its answer.
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.lsyNotifier service the channel provides.
import type {} from '@deepseek-ai/dsh-lsy-event-bus'
import type { SendFileResult, WechatChannel } from '@deepseek-ai/dsh-lsy-wechat'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Plugin name. */
export const name = 'lsy-tool-wechat'

/** Mounted inside an agent preset's scope, like other tool plugins. */
export const inject = ['tools']

const DESCRIPTION = [
  'Send a file from this computer to the owner on WeChat.',
  'A PNG, JPEG, GIF, or WebP image arrives as a picture, an .mp4, .mov, or .m4v file as a video, anything else as a file attachment.',
  'The recipient is always the owner, and sending works only while the owner\'s last WeChat message is recent (about a day) and its reply allowance is not used up; otherwise the result says why nothing was sent.',
  'Use it when the owner asks for a file or picture, or when one says more than text. Your final answer still goes out as the text reply.',
].join(' ')

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        sent: { type: 'string', required: true, enum: ['image', 'video', 'file'] },
        name: { type: 'string', required: true },
        bytes: { type: 'number', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { notSent: { type: 'string', required: true } },
    },
  ],
} as const

/**
 * Register `wechat_send_file` once the WeChat channel is mounted.
 * @param ctx - the preset scope's context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['lsyNotifier'], (scoped) => {
    const channel = scoped.lsyNotifier as Partial<Pick<WechatChannel, 'sendFile'>>
    scoped.tools.register(defineTool({
      name: 'wechat_send_file',
      description: DESCRIPTION,
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path of a regular file on this computer, at most 25 MiB.' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      async execute(args): Promise<SendFileResult> {
        if (typeof channel.sendFile !== 'function') return { notSent: 'the WeChat channel is not mounted' }
        return await channel.sendFile(args.path)
      },
      presentCall: args => ({ card: 'generic', title: `Send ${basename(args.path)} on WeChat`, kind: 'other', rawInput: args.path }),
    }))
  })
}
