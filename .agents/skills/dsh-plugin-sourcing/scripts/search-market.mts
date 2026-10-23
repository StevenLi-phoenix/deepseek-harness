/**
 * Search DSH plugin market indexes (format 1) for plugins matching every query word.
 * Each index is validated with the repository's own parseMarketIndex before it is searched.
 *
 *   pnpm exec tsx .agents/skills/dsh-plugin-sourcing/scripts/search-market.mts memory store
 *   pnpm exec tsx .agents/skills/dsh-plugin-sourcing/scripts/search-market.mts --index https://example/index.json monitor
 *
 * Prints, per match: name, latest version, its engines.dsh, source, repository, publish date, description.
 * Nothing is installed or executed; indexes are third-party data.
 */

import { parseMarketIndex, type MarketPlugin } from '@deepseek-ai/dsh-plugin-market-index'

const DEFAULT_INDEXES = [
  'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json',
  'https://raw.githubusercontent.com/wangyutansheng/dsh-market-index/main/index.json',
]
const MAX_BYTES = 128 * 1024 * 1024
const LIMIT = 15

const args = process.argv.slice(2)
const indexes: string[] = []
const words: string[] = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--index' && args[i + 1] !== undefined) indexes.push(args[++i]!)
  else words.push(args[i]!.toLowerCase())
}
if (words.length === 0) {
  console.error('usage: search-market.mts [--index <url>]... <word> [word...]')
  process.exit(2)
}

const localized = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, string>).join(' / ')
  return ''
}

const haystack = (plugin: MarketPlugin): string => [
  plugin.name, localized(plugin.title), localized(plugin.description), plugin.author ?? '',
  ...plugin.metadata.keywords, plugin.metadata.category ?? '',
].join(' ').toLowerCase()

for (const url of indexes.length > 0 ? indexes : DEFAULT_INDEXES) {
  let plugins: readonly MarketPlugin[]
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const body = await response.text()
    if (body.length > MAX_BYTES) throw new Error('index larger than 128 MiB')
    plugins = parseMarketIndex(JSON.parse(body), url).plugins
  } catch (error: unknown) {
    console.log(`\n# ${url}\n  unavailable: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const matches = plugins.filter(plugin => words.every(word => haystack(plugin).includes(word)))
  console.log(`\n# ${url}\n  ${String(plugins.length)} plugins, ${String(matches.length)} match "${words.join(' ')}"`)
  for (const plugin of matches.slice(0, LIMIT)) {
    const latest = plugin.versions[0]
    const source = latest === undefined ? '?' : latest.source.type === 'npm' ? 'npm' : `git ${'url' in latest.source ? String(latest.source.url) : ''}`
    // Generators disagree on seconds versus milliseconds.
    const stamp = latest === undefined ? 0 : latest.publishTimestamp < 1e12 ? latest.publishTimestamp * 1000 : latest.publishTimestamp
    const published = latest === undefined ? '?' : new Date(stamp).toISOString().slice(0, 10)
    console.log(`- ${plugin.name}@${latest?.version ?? '?'}  engines.dsh=${latest?.engines.dsh ?? 'any'}  ${source}  ${published}`)
    if (plugin.repository !== undefined) console.log(`  repo: ${plugin.repository.url}${plugin.repository.directory === undefined ? '' : ` (${plugin.repository.directory})`}`)
    console.log(`  ${localized(plugin.description).replace(/\s+/gu, ' ').slice(0, 220)}`)
  }
  if (matches.length > LIMIT) console.log(`  … ${String(matches.length - LIMIT)} more; add words to narrow`)
}
