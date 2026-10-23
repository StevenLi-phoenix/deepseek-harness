/** `lsy.sysmon` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '系统状态',
  'title': '系统状态',
  'status.loading': '正在读取…',
  'status.live': '{time} 更新',
  'status.stale': '未能刷新 · 显示 {time} 的数据',
  'status.failed': '暂时读不到系统状态，稍后自动重试。',
  'uptime': '已运行 {duration}',
  'duration.days': '{days} 天 {hours} 小时',
  'duration.hours': '{hours} 小时 {minutes} 分',
  'duration.minutes': '{minutes} 分钟',
  'value.unknown': '—',
  'cpu.title': 'CPU',
  'cpu.cores': '{cores} 核',
  'cpu.load': '负载 {load}',
  'cpu.measuring': '正在测量',
  'memory.title': '内存',
  'memory.of': '/ {total}',
  'memory.swap': '交换 {used} / {total}',
  'memory.approximate': '近似值：没有 macmon，按空闲页估算',
  'power.title': '功耗',
  'power.system': '整机',
  'power.parts': 'CPU {cpu} · GPU {gpu} · ANE {ane}',
  'power.temperature': 'CPU {cpu} · GPU {gpu}',
  'power.missing': '安装 macmon 后显示功耗与温度：',
  'power.failed': 'macmon 这次没有给出读数，功耗与温度暂缺。',
  'power.unsupported': '这台机器没有功耗传感器。',
  'storage.title': '存储',
  'storage.used': '已用 {used} / {total}',
  'storage.free': '剩余 {free}',
  'storage.skipped': '读不到（{reason}）',
  'reason.not found': '未挂载',
  'reason.not permitted': '无权限',
  'reason.unreadable': '无法读取',
} satisfies Record<string, string>

/** The system status namespace key union. */
export type SysmonKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The system status section's copy. */
    'lsy.sysmon': SysmonKey
  }
}

/** English dictionary. */
export const en: Record<SysmonKey, string> = {
  'nav': 'System status',
  'title': 'System status',
  'status.loading': 'Reading…',
  'status.live': 'Updated {time}',
  'status.stale': 'Not refreshing · showing {time}',
  'status.failed': 'The system status is unavailable right now; retrying automatically.',
  'uptime': 'Up {duration}',
  'duration.days': '{days} d {hours} h',
  'duration.hours': '{hours} h {minutes} min',
  'duration.minutes': '{minutes} min',
  'value.unknown': '—',
  'cpu.title': 'CPU',
  'cpu.cores': '{cores} cores',
  'cpu.load': 'Load {load}',
  'cpu.measuring': 'Measuring',
  'memory.title': 'Memory',
  'memory.of': 'of {total}',
  'memory.swap': 'Swap {used} of {total}',
  'memory.approximate': 'Approximate: without macmon, estimated from free pages',
  'power.title': 'Power',
  'power.system': 'Whole machine',
  'power.parts': 'CPU {cpu} · GPU {gpu} · ANE {ane}',
  'power.temperature': 'CPU {cpu} · GPU {gpu}',
  'power.missing': 'Install macmon to see power and temperature:',
  'power.failed': 'macmon gave no reading this time; power and temperature are unavailable.',
  'power.unsupported': 'This machine has no power sensors.',
  'storage.title': 'Storage',
  'storage.used': '{used} of {total} used',
  'storage.free': '{free} free',
  'storage.skipped': 'Unavailable ({reason})',
  'reason.not found': 'not mounted',
  'reason.not permitted': 'no permission',
  'reason.unreadable': 'unreadable',
}
