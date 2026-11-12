/**
 * The page Google's sign-in returns to: one static HTML document with the outcome and a link back to DSH. It runs no
 * script and loads nothing, and its headers keep the redirect URL (which holds the one-use code) out of any referrer.
 */

/** Headers of the page. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'',
  'x-content-type-options': 'nosniff',
}

/**
 * Escape text for HTML.
 * @param text - any text.
 * @returns the text with `& < > " '` as entities.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, char => `&#${char.charCodeAt(0)};`)
}

/**
 * The page.
 * @param outcome - `ok` when an account was connected, `failed` otherwise.
 * @param title - the heading, in Chinese.
 * @param detail - one line under it.
 * @returns the HTML document.
 */
export function signInPage(outcome: 'ok' | 'failed', title: string, detail: string): string {
  const accent = outcome === 'ok' ? '#1a7f37' : '#b42318'
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:Canvas;color:CanvasText}',
    `main{max-width:30rem;margin:16px;padding:24px 28px;border-radius:12px;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-top:4px solid ${accent}}`,
    'h1{font-size:1.25rem;margin:0 0 8px}p{margin:0 0 16px;overflow-wrap:anywhere}a{color:LinkText}',
    '</style></head><body><main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(detail)}</p>`,
    '<p><a href="/">回到 DSH → 设置 → 邮箱</a></p>',
    '</main></body></html>',
  ].join('\n')
}
