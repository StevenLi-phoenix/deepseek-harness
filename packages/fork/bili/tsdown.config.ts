import { clientBundle } from '../../client/tsdown.client.ts'

// `./text` is its own Node entry: an emitted-tree subpath would publish the client modules, whose CSS tsc does not emit.
export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/text.js'], {
  lib: { outputOptions: { chunkFileNames: '_chunks/[name]-[hash].js' } },
})
