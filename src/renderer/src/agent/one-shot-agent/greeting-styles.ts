// PLAN-greeting-styles：欢迎语风格池。随机性从模型收回到代码——每次生成前由
// pickGreetingStyle 预选一种风格注入 prompt，问候语在可控的风格间轮换，且
// 不连续两拍落在同一种（lastId 排除）。

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
