/** Shared retention presets; 0 = keep forever. Single home for the choices —
 *  对话管理 / 日常任务 / 常规·数据清理 all render from this one list (the two old
 *  copies had already drifted: 「7 天」 vs 「保留 7 天」). */
export const RETENTION_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 0, label: '永久保留' },
  { days: 7, label: '保留 7 天' },
  { days: 30, label: '保留 30 天' },
  { days: 90, label: '保留 90 天' },
]

/** Localize the labels without duplicating the choices across settings surfaces. */
export function retentionOptions(t: (key: string, values?: Record<string, string | number>) => string) {
  return RETENTION_OPTIONS.map(({ days }) => ({
    days,
    label: days === 0 ? t('dataRuntime.keepForever') : t('dataRuntime.keepDays', { n: days }),
  }))
}
