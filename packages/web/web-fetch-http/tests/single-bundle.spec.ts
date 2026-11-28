import { readdir, readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

// package.json publishes lib/index.js alone, so a local dynamic import becomes a split chunk the build leaves out
// (every web_fetch then failed with "Cannot find module …/lib/public-only-<hash>.js").
it('imports its own modules statically so the published lib stays one file', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] }
  expect(pkg.files.filter(file => file.startsWith('lib/') && file.endsWith('.js'))).toEqual(['lib/index.js'])
  const sources = (await readdir(new URL('../src/', import.meta.url))).filter(name => name.endsWith('.ts'))
  expect(sources.length).toBeGreaterThan(0)
  for (const name of sources) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
    expect(source, name).not.toMatch(/import\(\s*['"]\.\.?\//u)
  }
})
