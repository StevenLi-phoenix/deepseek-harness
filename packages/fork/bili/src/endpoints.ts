/**
 * The endpoint allowlist: every request this package can make, as an exact
 * method, host, and path (a pattern only where Bilibili puts an id in the
 * path). The client refuses anything else. Field names and codes follow the
 * community reference SocialSisterYi/bilibili-API-collect.
 */

/** One allowed request. */
export interface Endpoint {
  readonly method: 'GET' | 'POST'
  readonly host: string
  /** Exact path, or an anchored pattern for paths that carry an id. */
  readonly path: string | RegExp
  /** `read`, `write` (only the write guard calls these), or `auth` (login and cookie refresh). */
  readonly kind: 'read' | 'write' | 'auth'
  /** Send the account's cookies (never to a host outside `COOKIE_HOSTS`). */
  readonly cookies: boolean
  /** Refuse to send while signed out. */
  readonly signedIn?: boolean
  /** Sign the query with WBI. */
  readonly wbi?: boolean
  /** Form fields filled with the csrf cookie (`bili_jct`). */
  readonly csrfForm?: readonly string[]
  /** Query parameters filled with the csrf cookie. */
  readonly csrfQuery?: readonly string[]
  /** `Referer` (and, for POST, `Origin`) of the page that would make this request. */
  readonly referer?: string
  /** `text` for HTML answers, `file` for bare JSON files (subtitles); JSON with a `code` envelope otherwise. */
  readonly response?: 'json' | 'text' | 'file'
}

const API = 'api.bilibili.com'
const PASSPORT = 'passport.bilibili.com'
const VC = 'api.vc.bilibili.com'
const MESSAGE_PAGE = 'https://message.bilibili.com/'

/** Every allowed request, by name. */
export const ENDPOINTS = {
  // Sign-in (web QR) and cookie refresh.
  qrGenerate: { method: 'GET', host: PASSPORT, path: '/x/passport-login/web/qrcode/generate', kind: 'auth', cookies: false },
  qrPoll: { method: 'GET', host: PASSPORT, path: '/x/passport-login/web/qrcode/poll', kind: 'auth', cookies: false },
  fingerSpi: { method: 'GET', host: API, path: '/x/frontend/finger/spi', kind: 'auth', cookies: false },
  // The device fingerprint report a browser's first page sends; it gives buvid3 a server-side profile.
  exClimbWuzhi: { method: 'POST', host: API, path: '/x/internal/gaia-gateway/ExClimbWuzhi', kind: 'auth', cookies: true, referer: 'https://www.bilibili.com/' },
  cookieInfo: { method: 'GET', host: PASSPORT, path: '/x/passport-login/web/cookie/info', kind: 'auth', cookies: true, signedIn: true, csrfQuery: ['csrf'] },
  correspond: { method: 'GET', host: 'www.bilibili.com', path: /^\/correspond\/1\/[0-9a-f]{256}$/, kind: 'auth', cookies: true, signedIn: true, response: 'text' },
  cookieRefresh: { method: 'POST', host: PASSPORT, path: '/x/passport-login/web/cookie/refresh', kind: 'auth', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  confirmRefresh: { method: 'POST', host: PASSPORT, path: '/x/passport-login/web/confirm/refresh', kind: 'auth', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  nav: { method: 'GET', host: API, path: '/x/web-interface/nav', kind: 'read', cookies: true },

  // Reading.
  homeFeed: { method: 'GET', host: API, path: '/x/web-interface/wbi/index/top/feed/rcmd', kind: 'read', cookies: true, wbi: true },
  followingFeed: { method: 'GET', host: API, path: '/x/polymer/web-dynamic/v1/feed/all', kind: 'read', cookies: true, signedIn: true, referer: 'https://t.bilibili.com/' },
  popular: { method: 'GET', host: API, path: '/x/web-interface/popular', kind: 'read', cookies: true },
  search: { method: 'GET', host: API, path: '/x/web-interface/wbi/search/type', kind: 'read', cookies: true, wbi: true, referer: 'https://search.bilibili.com/' },
  // The site leaderboard (排行榜), all zones, as the ranking page reads it.
  ranking: { method: 'GET', host: API, path: '/x/web-interface/ranking/v2', kind: 'read', cookies: true, wbi: true, referer: 'https://www.bilibili.com/v/popular/rank/all' },
  // A video's danmaku as XML (`<d p="seconds,…">text</d>`), by its cid.
  danmaku: { method: 'GET', host: API, path: '/x/v1/dm/list.so', kind: 'read', cookies: true, response: 'text', referer: 'https://www.bilibili.com/' },
  // The hot-search list the search box shows (热搜), as RSSHub's bilibili/hot-search reads it.
  hotSearch: { method: 'GET', host: API, path: '/x/web-interface/wbi/search/square', kind: 'read', cookies: true, wbi: true, referer: 'https://www.bilibili.com/' },
  view: { method: 'GET', host: API, path: '/x/web-interface/view', kind: 'read', cookies: true },
  player: { method: 'GET', host: API, path: '/x/player/wbi/v2', kind: 'read', cookies: true, wbi: true },
  // Subtitle files: the URL comes from `player`; no cookies, only its own `auth_key`.
  subtitleAi: { method: 'GET', host: 'aisubtitle.hdslb.com', path: /^\/bfs\/(?:ai_)?subtitle\/[A-Za-z0-9_./-]+$/, kind: 'read', cookies: false, response: 'file' },
  subtitleFile: { method: 'GET', host: 'i0.hdslb.com', path: /^\/bfs\/(?:ai_)?subtitle\/[A-Za-z0-9_./-]+$/, kind: 'read', cookies: false, response: 'file' },
  replies: { method: 'GET', host: API, path: '/x/v2/reply/wbi/main', kind: 'read', cookies: true, wbi: true },
  replyThread: { method: 'GET', host: API, path: '/x/v2/reply/reply', kind: 'read', cookies: true },
  unread: { method: 'GET', host: API, path: '/x/msgfeed/unread', kind: 'read', cookies: true, signedIn: true, referer: MESSAGE_PAGE },
  replyFeed: { method: 'GET', host: API, path: '/x/msgfeed/reply', kind: 'read', cookies: true, signedIn: true, referer: MESSAGE_PAGE },
  atFeed: { method: 'GET', host: API, path: '/x/msgfeed/at', kind: 'read', cookies: true, signedIn: true, referer: MESSAGE_PAGE },
  dmUnread: { method: 'GET', host: VC, path: '/session_svr/v1/session_svr/single_unread', kind: 'read', cookies: true, signedIn: true, referer: MESSAGE_PAGE },
  dmMessages: { method: 'GET', host: VC, path: '/svr_sync/v1/svr_sync/fetch_session_msgs', kind: 'read', cookies: true, signedIn: true, referer: MESSAGE_PAGE },
  relationStat: { method: 'GET', host: API, path: '/x/relation/stat', kind: 'read', cookies: true },
  relation: { method: 'GET', host: API, path: '/x/relation', kind: 'read', cookies: true, signedIn: true },
  favFolders: { method: 'GET', host: API, path: '/x/v3/fav/folder/created/list-all', kind: 'read', cookies: true, signedIn: true },
  hasLike: { method: 'GET', host: API, path: '/x/web-interface/archive/has/like', kind: 'read', cookies: true, signedIn: true },
  watchLater: { method: 'GET', host: API, path: '/x/v2/history/toview', kind: 'read', cookies: true, signedIn: true },
  expReward: { method: 'GET', host: API, path: '/x/member/web/exp/reward', kind: 'read', cookies: true, signedIn: true },
  coinsGiven: { method: 'GET', host: API, path: '/x/web-interface/archive/coins', kind: 'read', cookies: true, signedIn: true },

  // Writing; only the write guard calls these.
  relationModify: { method: 'POST', host: API, path: '/x/relation/modify', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'], referer: 'https://space.bilibili.com/' },
  favDeal: { method: 'POST', host: API, path: '/x/v3/fav/resource/deal', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  like: { method: 'POST', host: API, path: '/x/web-interface/archive/like', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  watchLaterAdd: { method: 'POST', host: API, path: '/x/v2/history/toview/add', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  watchLaterDel: { method: 'POST', host: API, path: '/x/v2/history/toview/del', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  replyAdd: { method: 'POST', host: API, path: '/x/v2/reply/add', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  watchReport: { method: 'POST', host: API, path: '/x/click-interface/web/heartbeat', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  shareReport: { method: 'POST', host: API, path: '/x/web-interface/share/add', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  coin: { method: 'POST', host: API, path: '/x/web-interface/coin/add', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  triple: { method: 'POST', host: API, path: '/x/web-interface/archive/like/triple', kind: 'write', cookies: true, signedIn: true, csrfForm: ['csrf'] },
  dynamicCreate: { method: 'POST', host: API, path: '/x/dynamic/feed/create/dyn', kind: 'write', cookies: true, signedIn: true, wbi: true, csrfQuery: ['csrf'], referer: 'https://t.bilibili.com/' },
  dmSend: { method: 'POST', host: VC, path: '/web_im/v1/web_im/send_msg', kind: 'write', cookies: true, signedIn: true, wbi: true, csrfForm: ['csrf', 'csrf_token'], referer: MESSAGE_PAGE },
} as const satisfies Record<string, Endpoint>

/** Name of one allowed request. */
export type EndpointName = keyof typeof ENDPOINTS
