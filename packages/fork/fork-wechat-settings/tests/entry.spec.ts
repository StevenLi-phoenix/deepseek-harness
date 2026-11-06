import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as host from '../src/index.ts'

describe('fork-wechat-settings Host entry', () => {
  it('needs no service on the Host and loads', async () => {
    expect(host.apply).toHaveLength(0)
    expect('inject' in host).toBe(false)
    const ctx = new Context()
    await expect(ctx.plugin(host)).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
