/**
 * The fork bundles of the `event` profile, as the profile composes them: one directory per layer
 * under `fork/bundles/`, named in `fork/profiles/event/package.json` in mount order. Tests read the
 * composition through here, so a row that moved into its own bundle is still found, and a bundle
 * directory the profile does not list fails instead of silently losing its rows.
 */

import { globSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** One fork bundle layer: its package name and the patch file the profile mounts. */
export interface ForkBundleLayer {
  /** Package name the profile lists, such as `@deepseek-ai/bili`. */
  name: string
  /** Directory under `fork/bundles/`, such as `bili`. */
  dir: string
  /** Repository-relative path of the layer's `cordis.patch.yml`. */
  file: string
}

const defaultRoot = (): string => resolve(import.meta.dirname, '..')

/**
 * The fork bundle layers in the order the event profile mounts them.
 * @param root - Repository root; defaults to the checkout holding this script.
 * @returns One layer per directory under `fork/bundles/`, in `dsh.profile.bundles` order.
 */
export function forkBundleLayers(root: string = defaultRoot()): ForkBundleLayer[] {
  const manifest = JSON.parse(readFileSync(join(root, 'fork/profiles/event/package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  const byName = new Map<string, ForkBundleLayer>()
  for (const file of globSync('fork/bundles/*/package.json', { cwd: root })) {
    const dir = file.split('/')[2] ?? ''
    if (dir === '') throw new Error(`unreadable fork bundle path: ${file}`)
    const name = (JSON.parse(readFileSync(join(root, file), 'utf8')) as { name: string }).name
    byName.set(name, { name, dir, file: `fork/bundles/${dir}/cordis.patch.yml` })
  }
  const listed = manifest.dsh.profile.bundles
  const unlisted = [...byName.keys()].filter(name => !listed.includes(name))
  if (unlisted.length > 0) {
    throw new Error(`fork bundle(s) missing from fork/profiles/event/package.json: ${unlisted.sort().join(', ')}`)
  }
  const layers = listed.map(name => byName.get(name)).filter((layer): layer is ForkBundleLayer => layer !== undefined)
  if (layers.length === 0) throw new Error('no fork bundle layers found under fork/bundles/')
  return layers
}

/**
 * Every fork bundle's patch file, repository-relative, in mount order. A test parses them with the
 * `yaml` its package already depends on and concatenates the entries.
 * @param root - Repository root.
 * @returns The patch file paths of every fork bundle layer.
 */
export function forkPatchFiles(root: string = defaultRoot()): string[] {
  return forkBundleLayers(root).map(layer => layer.file)
}

/**
 * The text of every fork bundle's patch file, joined in mount order, for assertions that a name or
 * a forbidden token appears nowhere in the fork composition.
 * @param root - Repository root.
 * @returns The joined patch file text.
 */
export function forkPatchText(root: string = defaultRoot()): string {
  return forkBundleLayers(root).map(layer => readFileSync(join(root, layer.file), 'utf8')).join('\n')
}
