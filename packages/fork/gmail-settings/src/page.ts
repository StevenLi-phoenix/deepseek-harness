/**
 * The pages outside `/api`: the one Google's sign-in returns to, a static HTML document with the outcome and a link
 * back to DSH, and the OAuth app's privacy statement. They run no script and load nothing, and their headers keep the
 * redirect URL (which holds the one-use code) out of any referrer.
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

/** The privacy statement, in English (Google's reviewers read it) and in Chinese (the owner does). */
const PRIVACY: ReadonlyArray<{ readonly lang: string; readonly title: string; readonly lines: readonly string[] }> = [
  {
    lang: 'en',
    title: 'DSH Mail privacy statement',
    lines: [
      'DSH Mail connects the Gmail accounts of one person, the owner, to DSH, the assistant that owner runs on their own computer. No one else can sign in with it or use it.',
      'With the one permission it asks for (gmail.modify), DSH searches, reads, drafts, sends, and labels mail in a connected account when the owner\'s assistant is asked to, and moves mail to the trash; it never deletes mail permanently.',
      'Mail stays on the owner\'s computer, except that the parts the assistant reads become part of the owner\'s conversation with the language model provider the owner has configured. It is not sold, shared with anyone else, or used for advertising.',
      'The sign-in token is kept in the owner\'s local credential store. Disconnecting an account in DSH, or removing DSH Mail at myaccount.google.com/permissions, revokes it.',
      'Questions go to the support email shown on Google\'s consent page.',
    ],
  },
  {
    lang: 'zh-CN',
    title: 'DSH Mail 隐私说明',
    lines: [
      'DSH Mail 只把一个人（主人）的 Gmail 账号连接到 DSH，也就是主人在自己电脑上运行的助手。其他人不能用它登录或使用它。',
      '它只申请一项权限（gmail.modify）。主人的助手被要求时，DSH 在已连接的账号里搜索、读信、写草稿、发信、改标签，或把信移到垃圾箱；它从不永久删除邮件。',
      '邮件留在主人的电脑上；助手读到的部分会进入主人与其配置的语言模型服务之间的对话。邮件不会出售、不会给其他任何人，也不会用于广告。',
      '登录凭证保存在主人本机的凭据库里。在 DSH 里断开账号，或在 myaccount.google.com/permissions 移除 DSH Mail，都会撤销它。',
      '有问题请发到 Google 授权页上显示的支持邮箱。',
    ],
  },
]

/**
 * The privacy statement page: static, the same for every request.
 * @returns the HTML document.
 */
export function privacyPage(): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>DSH Mail privacy statement</title>',
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:Canvas;color:CanvasText}',
    'main{max-width:40rem;margin:0 auto;padding:24px 16px}h1{font-size:1.25rem;margin:24px 0 8px}p{margin:0 0 12px;overflow-wrap:anywhere}',
    '</style></head><body><main>',
    ...PRIVACY.flatMap(part => [
      `<section lang="${part.lang}">`,
      `<h1>${escapeHtml(part.title)}</h1>`,
      ...part.lines.map(line => `<p>${escapeHtml(line)}</p>`),
      '</section>',
    ]),
    '</main></body></html>',
  ].join('\n')
}
