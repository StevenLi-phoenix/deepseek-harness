import { clientBundle } from '../../client/tsdown.client.ts'

// `./wechat-view` and `./presence-view` are their own Node entries: an emitted-tree subpath would publish the client modules, whose CSS tsc does not emit.
export default clientBundle(import.meta.dirname, ['lib/types/index.js', 'lib/types/wechat-view.js', 'lib/types/presence-view.js'])
