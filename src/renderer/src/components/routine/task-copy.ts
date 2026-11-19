// ── 任务复制（user 2026-11-18）──
// 卡片上的「复制」：routine 与 workflow 共用一套命名与触发器口径。纯函数
// （无 React、无 IPC），tests/task-copy.test.ts 直接跑。
//
// 两条承重规则：
// 1. 名字先剥「副本」再递增——复制副本得到「X 副本 2」，不是「X 副本 副本」。
// 2. webhook 令牌不随副本走——令牌是主进程铸造的端点身份，两个任务共享同一
//    个 token 意味着一次 POST 同时触发两条；副本省略 token，由主进程的
//    normalizeTriggers 现铸一枚（UI 从不发明密钥）。文件触发器原样带走：
//    同一路径两个 watcher 各自触发，正是「复制」该有的语义。

import type { RoutineTrigger, RoutineWebhookTrigger } from '../../../../shared/types/routine'

/** 「<名字> <后缀>」/「<名字> <后缀> N」——N 在已有副本上递增。
 *  `suffix` 随 locale（zh「副本」/ en「copy」），由调用方传 t() 的文案。 */
export function copyName(name: string, suffix: string): string {
  const trimmed = name.trim()
  if (!trimmed) return suffix
  const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = trimmed.match(new RegExp(`^(.*?)\\s*${esc}(?:\\s*(\\d+))?$`))
  if (!m) return `${trimmed} ${suffix}`
  const n = m[2] ? Number(m[2]) : 1
  const base = m[1].trim()
  return base ? `${base} ${suffix} ${n + 1}` : `${suffix} ${n + 1}`
}

/** 副本的触发器：文件触发器原样带走（浅拷贝），webhook 省略 token 让主进程
 *  现铸。`as RoutineWebhookTrigger` 是诚实的：运行期 normalizeTriggers 对
 *  缺 token 的 webhook 条目铸一枚新令牌，类型层要求 token 只是为了读侧安全。 */
export function duplicateTriggers(triggers?: RoutineTrigger[]): RoutineTrigger[] | undefined {
  if (!triggers?.length) return undefined
  return triggers.map((t) =>
    t.type === 'webhook' ? ({ type: 'webhook' } as RoutineWebhookTrigger) : { ...t, paths: [...t.paths] },
  )
}
