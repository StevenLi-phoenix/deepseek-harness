/** `lsy.balance` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'pill.aria': 'DeepSeek 账号余额 {amount}，点击刷新',
  'pill.unavailable': '余额 —',
  'tooltip.wallet': '充值 {toppedUp} · 赠金 {granted}',
  'tooltip.updated': '{time} 更新 · 点击刷新',
  'tooltip.stale': '刷新失败，这是 {time} 的余额 · 点击重试',
  'tooltip.failed': '余额读取失败 · 点击重试',
  'tooltip.refreshing': '正在刷新…',
} satisfies Record<string, string>

/** The balance namespace key union. */
export type BalanceKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The balance pill's copy. */
    'lsy.balance': BalanceKey
  }
}

/** English dictionary. */
export const en: Record<BalanceKey, string> = {
  'pill.aria': 'DeepSeek account balance {amount}, click to refresh',
  'pill.unavailable': 'Balance —',
  'tooltip.wallet': 'Topped up {toppedUp} · Granted {granted}',
  'tooltip.updated': 'Updated {time} · click to refresh',
  'tooltip.stale': 'Refresh failed; balance as of {time} · click to retry',
  'tooltip.failed': 'Could not read the balance · click to retry',
  'tooltip.refreshing': 'Refreshing…',
}
