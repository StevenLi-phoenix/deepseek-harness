/** `lsy.balance` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'label.account': 'DeepSeek',
  'value.used': '已用 {amount}',
  'value.unavailable': '—',
  'pill.aria': '余额：{summary}。点击刷新',
  'tooltip.account': 'DeepSeek 账号',
  'tooltip.wallet': '{label}：充值 {toppedUp} · 赠金 {granted}',
  'tooltip.credit': '{label}：剩余 {remaining}（限额 {limit}，已用 {used}）',
  'tooltip.creditUnlimited': '{label}：已用 {used}（未设限额）',
  'tooltip.quota': '{label}：{windows}',
  'tooltip.quotaReset': '{window}额度 {time} 重置',
  'tooltip.failedSource': '{label}：读取失败（{reason}）',
  'tooltip.stale': 'DeepSeek 账号刷新失败，以上是 {time} 的余额',
  'tooltip.failed': 'DeepSeek 账号：余额读取失败',
  'tooltip.updated': '{time} 更新 · 点击刷新',
  'tooltip.refreshing': '正在刷新…',
  'window.fiveHour': '5 小时',
  'window.weekly': '每周',
  'window.monthly': '每月',
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
  'label.account': 'DeepSeek',
  'value.used': '{amount} used',
  'value.unavailable': '—',
  'pill.aria': 'Balances: {summary}. Click to refresh',
  'tooltip.account': 'DeepSeek account',
  'tooltip.wallet': '{label}: topped up {toppedUp} · granted {granted}',
  'tooltip.credit': '{label}: {remaining} left (limit {limit}, used {used})',
  'tooltip.creditUnlimited': '{label}: {used} used (no limit)',
  'tooltip.quota': '{label}: {windows}',
  'tooltip.quotaReset': '{window} quota resets {time}',
  'tooltip.failedSource': '{label}: could not read ({reason})',
  'tooltip.stale': 'DeepSeek account refresh failed; balance above as of {time}',
  'tooltip.failed': 'DeepSeek account: could not read the balance',
  'tooltip.updated': 'Updated {time} · click to refresh',
  'tooltip.refreshing': 'Refreshing…',
  'window.fiveHour': '5-hour',
  'window.weekly': 'Weekly',
  'window.monthly': 'Monthly',
}
