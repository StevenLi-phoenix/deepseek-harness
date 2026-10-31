/**
 * Run the probes against models and print a pass-rate table.
 *
 *   pnpm exec tsx lsy/probes/run.mts [--models haiku,sonnet] [--samples 3] [--only E1,E2] [--out <dir>]
 *
 * Models are Claude Code aliases run in print mode (the subscription, no API key) in an empty working
 * directory with no tools, hooks, skills, or CLAUDE.md files; `lm:<name>` is a model served by LM Studio
 * on 127.0.0.1:1234. Every raw answer is written to <out>/raw before it is parsed.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReply, PROBES, promptFor, type Reply } from './probes.mts'

const args = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback
}
const models = option('models', 'haiku,sonnet').split(',')
const samples = Number(option('samples', '3'))
const only = option('only', '').split(',').filter(id => id !== '')
const out = option('out', join('/tmp', `dsh-probes-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`))
const rawDir = join(out, 'raw')
mkdirSync(rawDir, { recursive: true })
const workdir = join(out, 'cwd')
mkdirSync(workdir, { recursive: true })

/** One model call; returns the model's text. */
async function ask(model: string, system: string, user: string): Promise<string> {
  if (model.startsWith('lm:')) {
    const response = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model.slice(3), temperature: 0.7, max_tokens: 1200, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(180_000),
    })
    const body = await response.text()
    return body
  }
  const run = spawnSync('claude', [
    '-p', user, '--model', model, '--system-prompt', system, '--tools', '', '--disable-slash-commands',
    '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--output-format', 'json',
  ], { cwd: workdir, env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }, encoding: 'utf8', timeout: 180_000, maxBuffer: 20 * 1024 * 1024 })
  return run.stdout + (run.status === 0 ? '' : `\n[exit ${String(run.status)}] ${run.stderr.slice(0, 300)}`)
}

/** The text of an answer from either backend. */
function textOf(model: string, raw: string): string {
  try {
    if (model.startsWith('lm:')) return (JSON.parse(raw) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content ?? ''
    const events = JSON.parse(raw) as Array<{ type?: string; result?: string }> | { result?: string }
    if (Array.isArray(events)) return events.find(event => event.type === 'result')?.result ?? ''
    return events.result ?? ''
  } catch {
    return raw
  }
}

interface Cell { passed: number; total: number; failures: string[] }
const table = new Map<string, Map<string, Cell>>()

for (const probe of PROBES.filter(entry => only.length === 0 || only.includes(entry.id))) {
  for (const model of models) {
    const cell: Cell = { passed: 0, total: 0, failures: [] }
    for (const [v, variant] of probe.variants.entries()) {
      for (let sample = 0; sample < samples; sample += 1) {
        const { system, user } = promptFor(probe, variant, model.replace(/^lm:/u, ''))
        const raw = await ask(model, system, user)
        writeFileSync(join(rawDir, `${probe.id}-${model.replaceAll(/[^a-z0-9]+/giu, '_')}-v${String(v)}-s${String(sample)}.json`), raw)
        const reply: Reply = parseReply(textOf(model, raw))
        const verdict = probe.check(reply)
        cell.total += 1
        if (verdict.pass) cell.passed += 1
        else cell.failures.push(`v${String(v)}: ${verdict.why}`)
        process.stderr.write(`${probe.id} ${model} v${String(v)} s${String(sample)}: ${verdict.pass ? 'pass' : `FAIL (${verdict.why})`}\n`)
      }
    }
    const row = table.get(probe.id) ?? new Map<string, Cell>()
    row.set(model, cell)
    table.set(probe.id, row)
  }
}

const lines = ['| Probe | What | ' + models.join(' | ') + ' |', '|---|---|' + models.map(() => '---').join('|') + '|']
for (const probe of PROBES.filter(entry => table.has(entry.id))) {
  const row = table.get(probe.id)!
  lines.push(`| ${probe.id} | ${probe.title} | ${models.map((model) => {
    const cell = row.get(model)
    return cell === undefined ? '-' : `${String(cell.passed)}/${String(cell.total)}`
  }).join(' | ')} |`)
}
// E10: the same persona probes across models.
const consistent = PROBES.filter(entry => ['E5', 'E9'].includes(entry.id) && table.has(entry.id))
if (consistent.length > 0) {
  lines.push(`| E10 | persona probes E5 and E9 across models | ${models.map((model) => {
    const cells = consistent.map(entry => table.get(entry.id)?.get(model)).filter((cell): cell is Cell => cell !== undefined)
    return `${String(cells.reduce((sum, cell) => sum + cell.passed, 0))}/${String(cells.reduce((sum, cell) => sum + cell.total, 0))}`
  }).join(' | ')} |`)
}
const report = lines.join('\n')
writeFileSync(join(out, 'table.md'), `${report}\n`)
writeFileSync(join(out, 'failures.json'), JSON.stringify(Object.fromEntries([...table].map(([id, row]) => [id, Object.fromEntries([...row].map(([model, cell]) => [model, cell.failures]))])), null, 1))
console.log(report)
console.log(`\nraw answers and failures: ${out}`)
