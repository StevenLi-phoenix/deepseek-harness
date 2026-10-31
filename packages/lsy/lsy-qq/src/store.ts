/**
 * The collector's database: one SQLite file (`node:sqlite`) holding the recorded groups' messages, their media,
 * and the digests made from them. Writes are incremental and idempotent: a message is unique by group and QQ
 * message id, so a reconnect or a backfill never doubles a row. Text search runs on an FTS5 index with the
 * trigram tokenizer, which finds any three-character run of Chinese or English text.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** A group the account is in. */
export interface GroupRow {
  groupId: string
  name: string
  memberCount: number | null
  updatedAt: number
}

/** A message to record. */
export interface NewMessage {
  groupId: string
  messageId: string
  seq?: string | undefined
  /** Epoch milliseconds. */
  at: number
  userId: string
  nickname: string
  card: string
  role: string
  text: string
  replyTo?: string | undefined
  kinds: string[]
  /** Segments as the protocol end sent them, for fidelity; dropped when the message is recalled. */
  raw?: string | undefined
  backfilled?: boolean | undefined
}

/** A stored message. */
export interface MessageRow {
  id: number
  groupId: string
  messageId: string
  at: number
  userId: string
  nickname: string
  card: string
  role: string
  text: string
  replyTo: string | null
  kinds: string
  recalled: boolean
}

/** A media item to record. */
export interface NewMedia {
  kind: string
  url?: string | undefined
  file?: string | undefined
  name?: string | undefined
  bytes?: number | undefined
}

/** A stored media item. */
export interface MediaRow {
  id: number
  messageRow: number
  kind: string
  url: string | null
  file: string | null
  name: string | null
  bytes: number | null
  localPath: string | null
  sha256: string | null
  transcript: string | null
  error: string | null
}

/** A digest of a run of messages. */
export interface DigestRow {
  id: number
  groupId: string
  fromRow: number
  toRow: number
  messageCount: number
  text: string
  model: string
  usage: string | null
  rawPath: string | null
  createdAt: number
}

/** A digest to record. */
export interface NewDigest {
  groupId: string
  fromRow: number
  toRow: number
  messageCount: number
  text: string
  model: string
  usage?: string | undefined
  rawPath?: string | undefined
  createdAt: number
}

/** Per-group counts for the group list. */
export interface GroupStats {
  groupId: string
  messages: number
  firstAt: number | null
  lastAt: number | null
  lastDigestAt: number | null
}

const SCHEMA_VERSION = 1

type Row = Record<string, unknown>

/** The store. */
export class QqStore {
  private readonly db: DatabaseSync

  /**
   * @param path - the database file, or `:memory:`; its directory is created (mode 0700).
   */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row)['user_version'])
    if (version >= SCHEMA_VERSION) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY, name TEXT NOT NULL, member_count INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL, message_id TEXT NOT NULL, seq TEXT,
        at INTEGER NOT NULL,
        user_id TEXT NOT NULL, nickname TEXT NOT NULL DEFAULT '', card TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL, reply_to TEXT, kinds TEXT NOT NULL DEFAULT '', raw TEXT,
        recalled INTEGER NOT NULL DEFAULT 0, backfilled INTEGER NOT NULL DEFAULT 0,
        UNIQUE (group_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_group_at ON messages (group_id, at);
      CREATE INDEX IF NOT EXISTS messages_group_user ON messages (group_id, user_id);
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_row INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        kind TEXT NOT NULL, url TEXT, file TEXT, name TEXT, bytes INTEGER,
        local_path TEXT, sha256 TEXT, transcript TEXT, error TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_message ON media (message_row);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (text, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TABLE IF NOT EXISTS digests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL, from_row INTEGER NOT NULL, to_row INTEGER NOT NULL, message_count INTEGER NOT NULL,
        text TEXT NOT NULL, model TEXT NOT NULL, usage TEXT, raw_path TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS digests_group ON digests (group_id, created_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  }

  close(): void {
    this.db.close()
  }

  /** Run `work` in one transaction. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---- groups ----

  upsertGroup(group: { groupId: string; name: string; memberCount?: number | undefined }, now: number): void {
    this.db.prepare(`
      INSERT INTO groups (group_id, name, member_count, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (group_id) DO UPDATE SET name = excluded.name, member_count = excluded.member_count, updated_at = excluded.updated_at
    `).run(group.groupId, group.name, group.memberCount ?? null, now)
  }

  groups(): GroupRow[] {
    return (this.db.prepare('SELECT group_id, name, member_count, updated_at FROM groups ORDER BY name').all() as Row[]).map(row => ({
      groupId: String(row['group_id']), name: String(row['name']), memberCount: row['member_count'] === null ? null : Number(row['member_count']), updatedAt: Number(row['updated_at']),
    }))
  }

  groupName(groupId: string): string | undefined {
    const row = this.db.prepare('SELECT name FROM groups WHERE group_id = ?').get(groupId) as Row | undefined
    return row === undefined ? undefined : String(row['name'])
  }

  // ---- messages ----

  /**
   * Record a message and its media; nothing happens when the group already holds that QQ message id.
   * @returns the new row id, or undefined for a duplicate.
   */
  insertMessage(message: NewMessage, media: NewMedia[], now: number): number | undefined {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO messages (group_id, message_id, seq, at, user_id, nickname, card, role, text, reply_to, kinds, raw, backfilled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.groupId, message.messageId, message.seq ?? null, message.at, message.userId, message.nickname, message.card, message.role,
        message.text, message.replyTo ?? null, message.kinds.join(','), message.raw ?? null, message.backfilled === true ? 1 : 0,
      )
      if (Number(result.changes) === 0) return undefined
      const id = Number(result.lastInsertRowid)
      const insertMedia = this.db.prepare('INSERT INTO media (message_row, kind, url, file, name, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const item of media) {
        insertMedia.run(id, item.kind, item.url ?? null, item.file ?? null, item.name ?? null, item.bytes ?? null, now)
      }
      return id
    })
  }

  hasMessage(groupId: string, messageId: string): boolean {
    return this.db.prepare('SELECT 1 FROM messages WHERE group_id = ? AND message_id = ?').get(groupId, messageId) !== undefined
  }

  /** Add words to a stored message (a voice transcript), keeping the search index current. */
  appendText(rowId: number, extra: string): void {
    this.db.prepare('UPDATE messages SET text = text || ? WHERE id = ?').run(extra, rowId)
  }

  /**
   * Mark a message recalled and drop what it said: its text, its raw segments, and its media rows.
   * @returns the local files of its media, for the caller to delete; undefined when the message is unknown.
   */
  recall(groupId: string, messageId: string): string[] | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM messages WHERE group_id = ? AND message_id = ?').get(groupId, messageId) as Row | undefined
      if (row === undefined) return undefined
      const id = Number(row['id'])
      const paths = (this.db.prepare('SELECT local_path FROM media WHERE message_row = ? AND local_path IS NOT NULL').all(id) as Row[]).map(r => String(r['local_path']))
      this.db.prepare('DELETE FROM media WHERE message_row = ?').run(id)
      this.db.prepare("UPDATE messages SET text = '', raw = NULL, recalled = 1 WHERE id = ?").run(id)
      return paths
    })
  }

  private messageRow(row: Row): MessageRow {
    return {
      id: Number(row['id']), groupId: String(row['group_id']), messageId: String(row['message_id']), at: Number(row['at']), userId: String(row['user_id']),
      nickname: String(row['nickname']), card: String(row['card']), role: String(row['role']), text: String(row['text']),
      replyTo: row['reply_to'] === null ? null : String(row['reply_to']), kinds: String(row['kinds']), recalled: Number(row['recalled']) === 1,
    }
  }

  /** Newest messages of a group since `sinceMs`, oldest first. */
  recent(groupId: string, options: { sinceMs?: number; limit: number; userId?: string }): MessageRow[] {
    const params: SQLInputValue[] = [groupId, options.sinceMs ?? 0]
    let user = ''
    if (options.userId !== undefined) {
      user = ' AND user_id = ?'
      params.push(options.userId)
    }
    params.push(options.limit)
    const rows = this.db.prepare(`SELECT * FROM messages WHERE group_id = ? AND at >= ? AND recalled = 0${user} ORDER BY at DESC, id DESC LIMIT ?`).all(...params) as Row[]
    return rows.map(row => this.messageRow(row)).reverse()
  }

  /** Messages of a group after a row id, oldest first, for the digest. */
  after(groupId: string, rowId: number, limit: number): MessageRow[] {
    return (this.db.prepare('SELECT * FROM messages WHERE group_id = ? AND id > ? AND recalled = 0 ORDER BY id LIMIT ?').all(groupId, rowId, limit) as Row[]).map(row => this.messageRow(row))
  }

  /** Quoted message of `messageId` in a group, when stored. */
  byMessageId(groupId: string, messageId: string): MessageRow | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE group_id = ? AND message_id = ?').get(groupId, messageId) as Row | undefined
    return row === undefined ? undefined : this.messageRow(row)
  }

  /**
   * Search message text. Three characters or more use the FTS5 trigram index; shorter queries scan with LIKE.
   * Newest first.
   */
  search(query: string, options: { groupId?: string; limit: number }): MessageRow[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const params: SQLInputValue[] = []
    let sql: string
    const group = options.groupId === undefined ? '' : ' AND m.group_id = ?'
    if (Array.from(trimmed).length >= 3) {
      params.push(`"${trimmed.replace(/"/g, '""')}"`)
      if (options.groupId !== undefined) params.push(options.groupId)
      sql = `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND m.recalled = 0${group} ORDER BY m.at DESC LIMIT ?`
    } else {
      params.push(`%${trimmed.replace(/[\\%_]/g, '\\$&')}%`)
      if (options.groupId !== undefined) params.push(options.groupId)
      sql = `SELECT m.* FROM messages m WHERE m.text LIKE ? ESCAPE '\\' AND m.recalled = 0${group} ORDER BY m.at DESC LIMIT ?`
    }
    params.push(options.limit)
    return (this.db.prepare(sql).all(...params) as Row[]).map(row => this.messageRow(row))
  }

  stats(): GroupStats[] {
    const rows = this.db.prepare(`
      SELECT m.group_id AS group_id, COUNT(*) AS messages, MIN(m.at) AS first_at, MAX(m.at) AS last_at,
        (SELECT MAX(d.created_at) FROM digests d WHERE d.group_id = m.group_id) AS last_digest
      FROM messages m WHERE m.recalled = 0 GROUP BY m.group_id
    `).all() as Row[]
    return rows.map(row => ({
      groupId: String(row['group_id']), messages: Number(row['messages']),
      firstAt: row['first_at'] === null ? null : Number(row['first_at']), lastAt: row['last_at'] === null ? null : Number(row['last_at']),
      lastDigestAt: row['last_digest'] === null ? null : Number(row['last_digest']),
    }))
  }

  /** Highest message row id of a group, or 0. */
  lastRow(groupId: string): number {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE group_id = ?').get(groupId) as Row
    return row['id'] === null ? 0 : Number(row['id'])
  }

  // ---- media ----

  mediaOf(rowId: number): MediaRow[] {
    return (this.db.prepare('SELECT * FROM media WHERE message_row = ? ORDER BY id').all(rowId) as Row[]).map(row => this.mediaRow(row))
  }

  private mediaRow(row: Row): MediaRow {
    const text = (value: unknown): string | null => (value === null ? null : String(value))
    return {
      id: Number(row['id']), messageRow: Number(row['message_row']), kind: String(row['kind']), url: text(row['url']), file: text(row['file']), name: text(row['name']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']), localPath: text(row['local_path']), sha256: text(row['sha256']), transcript: text(row['transcript']), error: text(row['error']),
    }
  }

  setMediaFile(mediaId: number, file: { localPath: string; sha256: string; bytes: number }): void {
    this.db.prepare('UPDATE media SET local_path = ?, sha256 = ?, bytes = ?, error = NULL WHERE id = ?').run(file.localPath, file.sha256, file.bytes, mediaId)
  }

  setMediaError(mediaId: number, error: string): void {
    this.db.prepare('UPDATE media SET error = ? WHERE id = ?').run(error.slice(0, 300), mediaId)
  }

  setTranscript(mediaId: number, transcript: string): void {
    this.db.prepare('UPDATE media SET transcript = ? WHERE id = ?').run(transcript, mediaId)
  }

  /** Bytes of downloaded media on disk, by the rows. */
  mediaBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM media WHERE local_path IS NOT NULL').get() as Row
    return Number(row['total'])
  }

  /** Downloaded media older than `beforeMs`, for retention. */
  expiredMedia(beforeMs: number): Array<{ id: number; localPath: string }> {
    return (this.db.prepare(`
      SELECT media.id AS id, media.local_path AS local_path FROM media JOIN messages ON messages.id = media.message_row
      WHERE media.local_path IS NOT NULL AND messages.at < ?
    `).all(beforeMs) as Row[]).map(row => ({ id: Number(row['id']), localPath: String(row['local_path']) }))
  }

  clearMediaFile(mediaId: number): void {
    this.db.prepare('UPDATE media SET local_path = NULL WHERE id = ?').run(mediaId)
  }

  // ---- digests ----

  insertDigest(digest: NewDigest): number {
    const result = this.db.prepare(`
      INSERT INTO digests (group_id, from_row, to_row, message_count, text, model, usage, raw_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(digest.groupId, digest.fromRow, digest.toRow, digest.messageCount, digest.text, digest.model, digest.usage ?? null, digest.rawPath ?? null, digest.createdAt)
    return Number(result.lastInsertRowid)
  }

  /** Newest digests, newest first. */
  digests(options: { groupId?: string; sinceMs?: number; limit: number }): DigestRow[] {
    const params: SQLInputValue[] = [options.sinceMs ?? 0]
    let group = ''
    if (options.groupId !== undefined) {
      group = ' AND group_id = ?'
      params.push(options.groupId)
    }
    params.push(options.limit)
    return (this.db.prepare(`SELECT * FROM digests WHERE created_at >= ?${group} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params) as Row[]).map(row => ({
      id: Number(row['id']), groupId: String(row['group_id']), fromRow: Number(row['from_row']), toRow: Number(row['to_row']), messageCount: Number(row['message_count']),
      text: String(row['text']), model: String(row['model']), usage: row['usage'] === null ? null : String(row['usage']),
      rawPath: row['raw_path'] === null ? null : String(row['raw_path']), createdAt: Number(row['created_at']),
    }))
  }

  /** Row id the latest digest of a group reached, or 0. */
  digestedUpTo(groupId: string): number {
    const row = this.db.prepare('SELECT MAX(to_row) AS id FROM digests WHERE group_id = ?').get(groupId) as Row
    return row['id'] === null ? 0 : Number(row['id'])
  }

  lastDigestAt(groupId: string): number {
    const row = this.db.prepare('SELECT MAX(created_at) AS at FROM digests WHERE group_id = ?').get(groupId) as Row
    return row['at'] === null ? 0 : Number(row['at'])
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? undefined : String(row['value'])
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
