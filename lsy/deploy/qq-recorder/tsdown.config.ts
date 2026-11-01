/**
 * Builds the qq-recorder service into one self-contained file: `pnpm exec tsdown -c lsy/deploy/qq-recorder/tsdown.config.ts`.
 * Every dependency (`ws`, `zod`) is inlined, so the deployed file runs under plain node with no `node_modules`.
 * `QQ_RECORDER_OUT` overrides the output directory.
 */
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'qq-recorder': join(import.meta.dirname, 'main.ts') },
  outDir: process.env['QQ_RECORDER_OUT'] ?? join(import.meta.dirname, 'dist'),
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  fixedExtension: true,
  dts: false,
  clean: true,
  minify: false,
  sourcemap: false,
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
})
