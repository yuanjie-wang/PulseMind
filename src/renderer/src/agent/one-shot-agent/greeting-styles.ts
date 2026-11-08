// PLAN-greeting-styles：欢迎语风格池。随机性从模型收回到代码——每次生成前由
// pickGreetingStyle 预选一种风格注入 prompt，问候语在可控的风格间轮换，且
// 不连续两拍落在同一种（lastId 排除）。
//
// 环境要素（user 2026-11-08 裁定）：时段/季节**各自 50%** 独立上送——每次都带
// 会把产出锚死在环境词上，风格轮换的空间被吃掉；概率注入让「带环境的问候」
// 本身也变成一种变化面。

export interface GreetingStyle {
  id: string
  name: string
  /** 注入 prompt 的风格描述；自带字数约束关键词，随风格一起钉住硬约束。 */
  instruction: string
}

export const GREETING_STYLES: GreetingStyle[] = [
  { id: 'warm', name: '温暖亲切', instruction: '真诚关怀，像老朋友打招呼，15字以内' },
  { id: 'playful', name: '俏皮幽默', instruction: '轻松诙谐，可以有点小机灵，15字以内' },
  { id: 'poetic', name: '诗意文艺', instruction: '意象化表达，借季节时段入景，15字以内' },
  { id: 'energetic', name: '元气满满', instruction: '明快有冲劲，带感染力，15字以内' },
  { id: 'calm', name: '沉静舒展', instruction: '平和从容，适合清晨深夜的低唤醒时刻，15字以内' },
]

/** 均匀随机选一种风格；传入 lastId 时从剩余风格中选（不连续两次同风格），
 *  池只有 1 个风格时恒返回它。用 Math.random 实现，便于 vi.spyOn 钉确定性。 */
export function pickGreetingStyle(lastId?: string): GreetingStyle {
  const pool = GREETING_STYLES
  if (pool.length <= 1) return pool[0]
  const rest = lastId ? pool.filter((s) => s.id !== lastId) : pool
  const candidates = rest.length > 0 ? rest : pool
  const idx = Math.floor(Math.random() * candidates.length)
  return candidates[Math.min(idx, candidates.length - 1)]
}

// ── 环境要素（时段/季节，各自 50% 上送）──

export function getTimeSlot(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 8) return '清晨'
  if (hour >= 8 && hour < 11) return '上午'
  if (hour >= 11 && hour < 13) return '中午'
  if (hour >= 13 && hour < 17) return '下午'
  if (hour >= 17 && hour < 19) return '傍晚'
  if (hour >= 19 && hour < 22) return '夜晚'
  return '深夜'
}

export function getSeason(): string {
  const month = new Date().getMonth() + 1
  if (month >= 3 && month <= 5) return '春天'
  if (month >= 6 && month <= 8) return '夏天'
  if (month >= 9 && month <= 11) return '秋天'
  return '冬天'
}

export interface GreetingEnv {
  /** null = 这一拍不上送（50% 独立判定）。 */
  season: string | null
  slot: string | null
}

/** 两次独立随机判定（各 50%）——季节与时段互不联动，四种组合都可能。
 *  rand 注入便于测试钉确定性。 */
export function pickGreetingEnv(rand: () => number = Math.random): GreetingEnv {
  return {
    season: rand() < 0.5 ? getSeason() : null,
    slot: rand() < 0.5 ? getTimeSlot() : null,
  }
}
