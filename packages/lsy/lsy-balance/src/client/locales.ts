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
  'window.paced': '{reading}，{pace}',
  'reset.today': '今天 {time}',
  'reset.tomorrow': '明天 {time}',
  'pace.elapsed': '时间已过 {percent}',
  'pace.projected': '照这个速度，到期约用 {percent}',
  'pace.runsOut': '照这个速度，{time} 用完',
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
  'window.paced': '{reading}; {pace}',
  'reset.today': 'today {time}',
  'reset.tomorrow': 'tomorrow {time}',
  'pace.elapsed': '{percent} of the time gone',
  'pace.projected': 'on pace for {percent} at the reset',
  'pace.runsOut': 'on pace to run out {time}',
}

/** Japanese dictionary, checked against the English keys. */
export const ja = {
  'title': 'その他のプロバイダー残高',
  'refresh': '更新',
  'refreshAria': 'その他のプロバイダー残高を更新',
  'updated': '{time} 更新',
  'refreshing': '更新中…',
  'value.used': '{amount} 使用済み',
  'value.unavailable': '—',
  'detail.wallet': 'チャージ {toppedUp} · 付与 {granted}',
  'detail.credit': '上限 {limit} · 使用済み {used}',
  'detail.noLimit': 'このキーには上限がありません',
  'detail.failed': '読み取れませんでした（{reason}）',
  'detail.reset': '{window}の枠は {time} にリセット',
  'window.fiveHour': '5 時間',
  'window.weekly': '週間',
  'window.monthly': '月間',
  'window.resets': '{percent}、{time} にリセット',
  'window.paced': '{reading}、{pace}',
  'reset.today': '今日 {time}',
  'reset.tomorrow': '明日 {time}',
  'pace.elapsed': '時間の {percent} が経過',
  'pace.projected': 'このペースだとリセット時に約 {percent}',
  'pace.runsOut': 'このペースだと {time} に使い切る',
} satisfies Record<BalanceKey, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'title': 'Saldos de otros proveedores',
  'refresh': 'Actualizar',
  'refreshAria': 'Actualizar los saldos de otros proveedores',
  'updated': 'Actualizado {time}',
  'refreshing': 'Actualizando…',
  'value.used': '{amount} usado',
  'value.unavailable': '—',
  'detail.wallet': 'Recargado {toppedUp} · concedido {granted}',
  'detail.credit': 'Límite {limit} · usado {used}',
  'detail.noLimit': 'Esta clave no tiene límite',
  'detail.failed': 'No se pudo leer ({reason})',
  'detail.reset': 'La cuota {window} se reinicia {time}',
  'window.fiveHour': 'de 5 horas',
  'window.weekly': 'semanal',
  'window.monthly': 'mensual',
  'window.resets': '{percent}, se reinicia {time}',
  'window.paced': '{reading}; {pace}',
  'reset.today': 'hoy a las {time}',
  'reset.tomorrow': 'mañana a las {time}',
  'pace.elapsed': '{percent} del tiempo transcurrido',
  'pace.projected': 'a este ritmo, {percent} al reiniciarse',
  'pace.runsOut': 'a este ritmo se agota {time}',
} satisfies Record<BalanceKey, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'title': 'Soldes des autres fournisseurs',
  'refresh': 'Actualiser',
  'refreshAria': 'Actualiser les soldes des autres fournisseurs',
  'updated': 'Actualisé {time}',
  'refreshing': 'Actualisation…',
  'value.used': '{amount} utilisé',
  'value.unavailable': '—',
  'detail.wallet': 'Rechargé {toppedUp} · offert {granted}',
  'detail.credit': 'Plafond {limit} · utilisé {used}',
  'detail.noLimit': 'Cette clé n’a pas de plafond',
  'detail.failed': 'Lecture impossible ({reason})',
  'detail.reset': 'Le quota {window} se réinitialise {time}',
  'window.fiveHour': 'de 5 heures',
  'window.weekly': 'hebdomadaire',
  'window.monthly': 'mensuel',
  'window.resets': '{percent}, réinitialisation {time}',
  'window.paced': '{reading} ; {pace}',
  'reset.today': 'aujourd’hui à {time}',
  'reset.tomorrow': 'demain à {time}',
  'pace.elapsed': '{percent} du temps écoulé',
  'pace.projected': 'à ce rythme, {percent} à la réinitialisation',
  'pace.runsOut': 'à ce rythme, épuisé {time}',
} satisfies Record<BalanceKey, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'title': 'Guthaben anderer Anbieter',
  'refresh': 'Aktualisieren',
  'refreshAria': 'Guthaben anderer Anbieter aktualisieren',
  'updated': 'Aktualisiert {time}',
  'refreshing': 'Wird aktualisiert…',
  'value.used': '{amount} verbraucht',
  'value.unavailable': '—',
  'detail.wallet': 'Aufgeladen {toppedUp} · gewährt {granted}',
  'detail.credit': 'Limit {limit} · verbraucht {used}',
  'detail.noLimit': 'Dieser Schlüssel hat kein Limit',
  'detail.failed': 'Konnte nicht gelesen werden ({reason})',
  'detail.reset': 'Das {window}-Kontingent wird {time} zurückgesetzt',
  'window.fiveHour': '5-Stunden',
  'window.weekly': 'Wochen',
  'window.monthly': 'Monats',
  'window.resets': '{percent}, Zurücksetzung {time}',
  'window.paced': '{reading}; {pace}',
  'reset.today': 'heute um {time}',
  'reset.tomorrow': 'morgen um {time}',
  'pace.elapsed': '{percent} der Zeit vergangen',
  'pace.projected': 'bei diesem Tempo {percent} bei der Zurücksetzung',
  'pace.runsOut': 'bei diesem Tempo {time} aufgebraucht',
} satisfies Record<BalanceKey, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'title': 'Балансы других провайдеров',
  'refresh': 'Обновить',
  'refreshAria': 'Обновить балансы других провайдеров',
  'updated': 'Обновлено {time}',
  'refreshing': 'Обновление…',
  'value.used': 'Использовано {amount}',
  'value.unavailable': '—',
  'detail.wallet': 'Пополнено {toppedUp} · начислено {granted}',
  'detail.credit': 'Лимит {limit} · использовано {used}',
  'detail.noLimit': 'У этого ключа нет лимита',
  'detail.failed': 'Не удалось прочитать ({reason})',
  'detail.reset': '{window} квота сбрасывается {time}',
  'window.fiveHour': '5-часовая',
  'window.weekly': 'Недельная',
  'window.monthly': 'Месячная',
  'window.resets': '{percent}, сброс {time}',
  'window.paced': '{reading}; {pace}',
  'reset.today': 'сегодня в {time}',
  'reset.tomorrow': 'завтра в {time}',
  'pace.elapsed': 'прошло {percent} времени',
  'pace.projected': 'при таком темпе к сбросу около {percent}',
  'pace.runsOut': 'при таком темпе закончится {time}',
} satisfies Record<BalanceKey, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'title': 'Saldos de outros provedores',
  'refresh': 'Atualizar',
  'refreshAria': 'Atualizar os saldos de outros provedores',
  'updated': 'Atualizado {time}',
  'refreshing': 'Atualizando…',
  'value.used': '{amount} usado',
  'value.unavailable': '—',
  'detail.wallet': 'Recarregado {toppedUp} · concedido {granted}',
  'detail.credit': 'Limite {limit} · usado {used}',
  'detail.noLimit': 'Esta chave não tem limite',
  'detail.failed': 'Não foi possível ler ({reason})',
  'detail.reset': 'A cota {window} é redefinida {time}',
  'window.fiveHour': 'de 5 horas',
  'window.weekly': 'semanal',
  'window.monthly': 'mensal',
  'window.resets': '{percent}, redefinida {time}',
  'window.paced': '{reading}; {pace}',
  'reset.today': 'hoje às {time}',
  'reset.tomorrow': 'amanhã às {time}',
  'pace.elapsed': '{percent} do tempo decorrido',
  'pace.projected': 'neste ritmo, {percent} na redefinição',
  'pace.runsOut': 'neste ritmo, acaba {time}',
} satisfies Record<BalanceKey, string>
