// ── Friendly schedule builder (cron ⇄ structured config) ──
// Routines are configured by non-technical users: the editor speaks in
// 每天/每周/每月/每隔 patterns and only exposes raw cron under "高级". This
// module is the single translator between the two, kept pure so vitest can
// cover the round-trips without React.

/** Weekday numbers follow the cron day-of-week field: 0=周日 … 6=周六. */
export type ScheduleConfig =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'monthly'; day: number; time: string }
  | { kind: 'interval'; unit: 'minute' | 'hour'; every: number }
  | { kind: 'custom'; cron: string }

/** Display labels indexed by cron weekday number. */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function parseTime(hour: string, minute: string): string | null {
  const h = Number(hour)
  const m = Number(minute)
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return null
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "1-5" → [1,2,3,4,5]; "0,6" → [0,6]. null = not a plain weekday list. */
function parseWeekdayField(field: string): number[] | null {
  if (!/^[\d,-]+$/.test(field)) return null
  const out = new Set<number>()
  for (const seg of field.split(',')) {
    const range = seg.match(/^(\d+)-(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to || to > 6) return null
      for (let d = from; d <= to; d++) out.add(d)
      continue
    }
    if (!/^\d$/.test(seg)) return null
    const d = Number(seg)
    if (d > 6) return null
    out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

/** Best-effort friendly parse; anything the patterns don't cover falls back
 *  to { kind: 'custom' } so the original expression survives editing. */
export function parseCronToConfig(cron: string): ScheduleConfig {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { kind: 'custom', cron }
  const [minute, hour, dom, month, dow] = parts
  if (month !== '*') return { kind: 'custom', cron }

  // Every N minutes: */N * * * * — bare * * * * * is every minute.
  if (hour === '*' && dom === '*' && dow === '*' && /^\*\/\d+$/.test(minute)) {
    const every = Number(minute.slice(2))
    if (every >= 1 && every <= 59) return { kind: 'interval', unit: 'minute', every }
  }
  if (minute === '*' && hour === '*' && dom === '*' && dow === '*') {
    return { kind: 'interval', unit: 'minute', every: 1 }
  }
  // Every N hours (on the hour): 0 */N * * * — 0 * * * * is hourly.
  if (minute === '0' && dom === '*' && dow === '*' && /^\*\/\d+$/.test(hour)) {
    const every = Number(hour.slice(2))
    if (every >= 1 && every <= 23) return { kind: 'interval', unit: 'hour', every }
  }
  if (minute === '0' && hour === '*' && dom === '*' && dow === '*') {
    return { kind: 'interval', unit: 'hour', every: 1 }
  }
  // Every day at HH:MM: M H * * *
  if (dom === '*' && dow === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const time = parseTime(hour, minute)
    if (time) return { kind: 'daily', time }
  }
  // Weekly on chosen days: M H * * D[,D…|-D]
  if (dom === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const weekdays = parseWeekdayField(dow)
    const time = parseTime(hour, minute)
    if (weekdays && weekdays.length > 0 && time) return { kind: 'weekly', weekdays, time }
  }
  // Monthly on day D: M H D * *
  if (dow === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom)) {
    const day = Number(dom)
    const time = parseTime(hour, minute)
    if (day >= 1 && day <= 31 && time) return { kind: 'monthly', day, time }
  }
  return { kind: 'custom', cron }
}

export function configToCron(config: ScheduleConfig): string {
  switch (config.kind) {
    case 'custom':
      return config.cron
    case 'daily': {
      const [h, m] = config.time.split(':').map(Number)
      return `${m} ${h} * * *`
    }
    case 'weekly': {
      const [h, m] = config.time.split(':').map(Number)
      return `${m} ${h} * * ${[...config.weekdays].sort((a, b) => a - b).join(',')}`
    }
    case 'monthly': {
      const [h, m] = config.time.split(':').map(Number)
      return `${m} ${h} ${config.day} * *`
    }
    case 'interval':
      return config.unit === 'minute'
        ? (config.every === 1 ? '* * * * *' : `*/${config.every} * * * *`)
        : (config.every === 1 ? '0 * * * *' : `0 */${config.every} * * *`)
  }
}
