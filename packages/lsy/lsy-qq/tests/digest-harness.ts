/** Test doubles for the DSH side: an in-memory `lsy_qq` domain and a message log that answers like the recorder. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { DigestStore, qqDomain } from '../src/digest-storage.ts'
import type { MessageReader } from '../src/digest.ts'
import type { Member, Message } from '../src/protocol.ts'

/** Mount the storage domain facility on `ctx` over an in-memory backend, as a deployment's storage plugin would. */
export async function mountMemoryStorage(ctx: Context, pool: MemoryMediaPool = new MemoryMediaPool()): Promise<void> {
  await ctx.plugin(Storage)
  mountFacility(ctx, pool)
}

/** The facility half of {@link mountMemoryStorage}, for a context where the storage service is already mounted. */
export function mountFacility(ctx: Context, pool: MemoryMediaPool): void {
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
}

/** An open `lsy_qq` domain on a throwaway context. */
export async function memoryStore(pool?: MemoryMediaPool): Promise<{ ctx: Context; store: DigestStore; close(): Promise<void> }> {
  const ctx = new Context()
  await mountMemoryStorage(ctx, pool)
  const domain = await ctx.storageDomain.open(qqDomain)
  return { ctx, store: new DigestStore(domain), close: async () => { await domain.close(); await ctx.fiber.dispose() } }
}

/** What a group's recorded messages look like to the digest, in log order, with the recorder's cursor scheme. */
export class FakeLog implements MessageReader {
  readonly rows: Message[] = []
  readonly names = new Map<string, string>()
  /** Set to make `members` fail or say it cannot know. */
  membersAnswer: Member[] | 'unavailable' | 'error' | undefined
  private serial = 0

  /** Append a message. @returns it. */
  insert(message: Partial<Message> & { groupId: string; text: string }): Message {
    this.serial += 1
    const row: Message = {
      cursor: `c${this.serial}`, messageId: `${message.groupId}-${this.serial}`, at: 1_000 + this.serial, userId: '10001', nickname: '', card: '', role: 'member',
      replyTo: null, kinds: 'text', recalled: false, ...message,
    }
    this.rows.push(row)
    return row
  }

  async page(groupId: string, after: string | undefined, limit: number): Promise<{ items: Message[]; nextCursor: string | null }> {
    const from = after === undefined ? 0 : Number(after.slice(1))
    const items = this.rows.filter(row => row.groupId === groupId && !row.recalled && Number(row.cursor.slice(1)) > from).slice(0, limit)
    return { items, nextCursor: items.length >= limit ? items.at(-1)?.cursor ?? null : null }
  }

  async lookup(groupId: string, ids: readonly string[]): Promise<Message[]> {
    return this.rows.filter(row => row.groupId === groupId && ids.includes(row.messageId))
  }

  async members(groupId: string): Promise<Member[] | undefined> {
    if (this.membersAnswer === 'error') throw new Error('the recorder did not answer')
    if (this.membersAnswer === 'unavailable') return undefined
    if (this.membersAnswer !== undefined) return this.membersAnswer
    return [...new Map(this.rows.filter(row => row.groupId === groupId).map(row => [`${row.userId}|${row.nickname}|${row.card}`, { userId: row.userId, nickname: row.nickname, card: row.card }])).values()]
  }

  groupName(groupId: string): string {
    return this.names.get(groupId) ?? groupId
  }
}
