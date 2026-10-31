/**
 * The endpoint names this package may ask bili-svc for. bili-svc keeps the allowlist that matters
 * (method, host, path, WBI, csrf, cookies) and the session; these names are its door's names
 * (`POST /v1/bili/call`), and this table only says which are reads and which are actions, how an
 * answer comes back, and where subtitle files live (their URL comes from `player`). Speech
 * (comments, replies, dynamics, private messages, share reports) has no name here: this package
 * cannot ask for it.
 */

/** One endpoint of bili-svc's door. */
export interface Endpoint {
  readonly method: 'GET' | 'POST'
  readonly host: string
  /** Exact path, or an anchored pattern for subtitle files, whose path bili-svc takes as a suffix. */
  readonly path: string | RegExp
  /** `read`, or `write` for an action bili-svc caps, ledgers, and spaces. */
  readonly kind: 'read' | 'write'
  /** `text` for XML or HTML answers, `file` for bare JSON files (subtitles); a JSON `code` envelope otherwise. */
  readonly response?: 'json' | 'text' | 'file'
}

const API = 'api.bilibili.com'
const VC = 'api.vc.bilibili.com'
const SUBTITLE_PATH = /^\/bfs\/(?:ai_)?subtitle\/[A-Za-z0-9_./-]+$/

/** Every endpoint this package may name, by bili-svc's allowlist name. */
export const ENDPOINTS = {
  // Reading.
  nav: { method: 'GET', host: API, path: '/x/web-interface/nav', kind: 'read' },
  homeFeed: { method: 'GET', host: API, path: '/x/web-interface/wbi/index/top/feed/rcmd', kind: 'read' },
  followingFeed: { method: 'GET', host: API, path: '/x/polymer/web-dynamic/v1/feed/all', kind: 'read' },
  popular: { method: 'GET', host: API, path: '/x/web-interface/popular', kind: 'read' },
  search: { method: 'GET', host: API, path: '/x/web-interface/wbi/search/type', kind: 'read' },
  ranking: { method: 'GET', host: API, path: '/x/web-interface/ranking/v2', kind: 'read' },
  danmaku: { method: 'GET', host: API, path: '/x/v1/dm/list.so', kind: 'read', response: 'text' },
  hotSearch: { method: 'GET', host: API, path: '/x/web-interface/wbi/search/square', kind: 'read' },
  view: { method: 'GET', host: API, path: '/x/web-interface/view', kind: 'read' },
  player: { method: 'GET', host: API, path: '/x/player/wbi/v2', kind: 'read' },
  subtitleAi: { method: 'GET', host: 'aisubtitle.hdslb.com', path: SUBTITLE_PATH, kind: 'read', response: 'file' },
  subtitleFile: { method: 'GET', host: 'i0.hdslb.com', path: SUBTITLE_PATH, kind: 'read', response: 'file' },
  replies: { method: 'GET', host: API, path: '/x/v2/reply/wbi/main', kind: 'read' },
  replyThread: { method: 'GET', host: API, path: '/x/v2/reply/reply', kind: 'read' },
  unread: { method: 'GET', host: API, path: '/x/msgfeed/unread', kind: 'read' },
  replyFeed: { method: 'GET', host: API, path: '/x/msgfeed/reply', kind: 'read' },
  atFeed: { method: 'GET', host: API, path: '/x/msgfeed/at', kind: 'read' },
  dmUnread: { method: 'GET', host: VC, path: '/session_svr/v1/session_svr/single_unread', kind: 'read' },
  dmMessages: { method: 'GET', host: VC, path: '/svr_sync/v1/svr_sync/fetch_session_msgs', kind: 'read' },
  relationStat: { method: 'GET', host: API, path: '/x/relation/stat', kind: 'read' },
  relation: { method: 'GET', host: API, path: '/x/relation', kind: 'read' },
  favFolders: { method: 'GET', host: API, path: '/x/v3/fav/folder/created/list-all', kind: 'read' },
  hasLike: { method: 'GET', host: API, path: '/x/web-interface/archive/has/like', kind: 'read' },
  watchLater: { method: 'GET', host: API, path: '/x/v2/history/toview', kind: 'read' },
  expReward: { method: 'GET', host: API, path: '/x/member/web/exp/reward', kind: 'read' },
  coinsGiven: { method: 'GET', host: API, path: '/x/web-interface/archive/coins', kind: 'read' },

  // Actions: bili-svc checks its brake, daily cap, and once-rules, waits for its sender slot, and ledgers each.
  relationModify: { method: 'POST', host: API, path: '/x/relation/modify', kind: 'write' },
  favDeal: { method: 'POST', host: API, path: '/x/v3/fav/resource/deal', kind: 'write' },
  like: { method: 'POST', host: API, path: '/x/web-interface/archive/like', kind: 'write' },
  watchLaterAdd: { method: 'POST', host: API, path: '/x/v2/history/toview/add', kind: 'write' },
  watchLaterDel: { method: 'POST', host: API, path: '/x/v2/history/toview/del', kind: 'write' },
  coin: { method: 'POST', host: API, path: '/x/web-interface/coin/add', kind: 'write' },
  triple: { method: 'POST', host: API, path: '/x/web-interface/archive/like/triple', kind: 'write' },
  watchReport: { method: 'POST', host: API, path: '/x/click-interface/web/heartbeat', kind: 'write' },
} as const satisfies Record<string, Endpoint>

/** Name of one endpoint. */
export type EndpointName = keyof typeof ENDPOINTS

/**
 * Whether a name is one of {@link ENDPOINTS}.
 * @param name - a name from anywhere.
 */
export function isEndpointName(name: unknown): name is EndpointName {
  return typeof name === 'string' && Object.hasOwn(ENDPOINTS, name)
}
