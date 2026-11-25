import { clientBundle } from '../../client/tsdown.client.ts'

// `./view` is its own Node entry: an emitted-tree subpath would publish the client modules, whose CSS tsc does not emit.
export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/view.js'])
