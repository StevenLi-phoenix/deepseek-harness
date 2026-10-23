/** `lsy.balance` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '其他供应商余额',
  'refresh': '刷新',
  'refreshAria': '刷新其他供应商余额',
  'updated': '{time} 更新',
  'refreshing': '正在刷新…',
  'value.used': '已用 {amount}',
  'value.unavailable': '—',
  'detail.wallet': '充值 {toppedUp} · 赠金 {granted}',
  'detail.credit': '限额 {limit} · 已用 {used}',
  'detail.noLimit': '这个 key 没有设置限额',
  'detail.failed': '读取失败（{reason}）',
  'detail.reset': '{window}额度 {time} 重置',
  'window.fiveHour': '5 小时',
  'window.weekly': '每周',
  'window.monthly': '每月',
  'window.resets': '{percent}，{time} 重置',
  'reset.today': '今天 {time}',
  'reset.tomorrow': '明天 {time}',
} satisfies Record<string, string>

/** The balance namespace key union. */
export type BalanceKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The provider balance card's copy. */
    'lsy.balance': BalanceKey
  }
}

/** English dictionary. */
export const en: Record<BalanceKey, string> = {
  'title': 'Other provider balances',
  'refresh': 'Refresh',
  'refreshAria': 'Refresh other provider balances',
  'updated': 'Updated {time}',
  'refreshing': 'Refreshing…',
  'value.used': '{amount} used',
  'value.unavailable': '—',
  'detail.wallet': 'Topped up {toppedUp} · granted {granted}',
  'detail.credit': 'Limit {limit} · used {used}',
  'detail.noLimit': 'This key has no limit',
  'detail.failed': 'Could not read ({reason})',
  'detail.reset': '{window} quota resets {time}',
  'window.fiveHour': '5-hour',
  'window.weekly': 'Weekly',
  'window.monthly': 'Monthly',
  'window.resets': '{percent}, resets {time}',
  'reset.today': 'today {time}',
  'reset.tomorrow': 'tomorrow {time}',
}
