#!/usr/bin/env node
// Disk-usage watcher for the lsy event service: every DISK_WATCH_INTERVAL_S seconds it reads each
// volume with statfs and, while one is above DISK_WATCH_THRESHOLD (default 0.95 = 95 %), pushes
// `host.disk.full` to dsh's lsy-event-ingest route. The key carries the volume and the date, so the
// bus turns a full disk into at most one warning per volume per day. Runs as an AMS service
// (dsh-runtime), so no launchd job of its own; push failures are logged at level "error", which AMS
// escalates. No dependencies; nothing is read from the network.
//   env: LSY_INGEST_TOKEN (required, the `host` source token), LSY_INGEST_URL,
//        DISK_WATCH_MOUNTS ("/path:Label,..."), DISK_WATCH_THRESHOLD, DISK_WATCH_INTERVAL_S
//   --once: check once and exit (exit 1 when a push failed), for testing.
import { statfs } from 'node:fs/promises'

const URL = process.env.LSY_INGEST_URL || 'http://127.0.0.1:3081/hooks/lsy'
const TOKEN = (process.env.LSY_INGEST_TOKEN || '').trim()
const THRESHOLD = Number(process.env.DISK_WATCH_THRESHOLD || '0.95')
const INTERVAL_S = Number(process.env.DISK_WATCH_INTERVAL_S || '300')
const MOUNTS = (process.env.DISK_WATCH_MOUNTS || '/System/Volumes/Data:Internal,/Volumes/MiniSSD:MiniSSD')
  .split(',').map(entry => entry.trim()).filter(Boolean).map((entry) => {
    const colon = entry.lastIndexOf(':')
    return colon > 0 ? { mount: entry.slice(0, colon), label: entry.slice(colon + 1) } : { mount: entry, label: entry }
  })

const log = (level, msg, fields = {}) => {
  const line = JSON.stringify({ level, msg, service: 'disk-watch', ...fields, ts: new Date().toISOString() })
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

const gb = bytes => Math.round(bytes / 1e9)

/** df's "Capacity": used / (used + available to unprivileged users). */
async function usage({ mount, label }) {
  const s = await statfs(mount)
  const used = (s.blocks - s.bfree) * s.bsize
  const avail = s.bavail * s.bsize
  return { mount, label, used, avail, total: s.blocks * s.bsize, ratio: used / (used + avail) }
}

async function push(disk) {
  const pct = Math.round(disk.ratio * 1000) / 10
  const today = new Date().toLocaleDateString('en-CA')
  const body = {
    kind: 'host.disk.full',
    key: `disk-${disk.label}-${today}`,
    subject: disk.label,
    title: `${disk.label} 磁盘已用 ${pct}%，只剩 ${gb(disk.avail)} GB`,
    text: `${disk.mount}: used ${gb(disk.used)} GB of ${gb(disk.total)} GB (${pct}%), ${gb(disk.avail)} GB free; threshold ${Math.round(THRESHOLD * 100)}%.`,
  }
  const response = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`HTTP ${response.status} ${answer.error ?? ''}`.trim())
  return answer.outcome
}

async function check() {
  let failed = false
  for (const target of MOUNTS) {
    let disk
    try {
      disk = await usage(target)
    } catch (error) {
      log('warn', 'statfs failed', { mount: target.mount, error: error.code ?? String(error) })
      continue
    }
    if (disk.ratio <= THRESHOLD) continue
    try {
      const outcome = await push(disk)
      log('info', 'disk above threshold pushed', { mount: disk.mount, ratio: Math.round(disk.ratio * 1000) / 1000, outcome })
    } catch (error) {
      failed = true
      log('error', 'push failed', { mount: disk.mount, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return failed
}

if (TOKEN === '') {
  log('error', 'LSY_INGEST_TOKEN is not set')
  process.exit(78)
}
if (!(THRESHOLD > 0 && THRESHOLD < 1) || !(INTERVAL_S >= 10)) {
  log('error', 'bad DISK_WATCH_THRESHOLD or DISK_WATCH_INTERVAL_S', { threshold: THRESHOLD, intervalS: INTERVAL_S })
  process.exit(64)
}
if (process.argv.includes('--once')) {
  process.exit((await check()) ? 1 : 0)
}
log('info', 'started', { mounts: MOUNTS.map(m => m.mount), threshold: THRESHOLD, intervalS: INTERVAL_S })
await check()
const timer = setInterval(() => { void check() }, INTERVAL_S * 1000)
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(timer); process.exit(0) })
