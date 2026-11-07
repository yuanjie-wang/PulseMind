/** 「输入法确认上屏」的回车 ≠ 「确认提交」的回车 —— 同一枚 keydown，三层判据。
 *
 *  中文/日文输入法把组合串上屏的那一下回车，与用户主动按下提交的回车在 DOM
 *  上是同一个 keydown Enter。漏挡它，ask_user 的自定义回答会把拼音串（或用户
 *  本想上屏的英文）当成答案直接发出去——这一步不可逆（答案已进引擎）。
 *
 *  三层缺一不可：
 *    1. `isComposing` —— 组合进行中的回车（Chromium 的主流路径）；
 *    2. `keyCode === 229` —— 输入法正在处理该按键的兜底：Windows 的搜狗 /
 *       微软拼音在组合期把 keyCode 钉在 229，而 `isComposing` 可能已是 false；
 *    3. compositionend 后的短窗口 —— macOS/Chromium 的穿透：确认上屏时先派发
 *       compositionend、再派发一个 `isComposing === false` 的 keydown Enter，
 *       前两层都拦不住（用户实测的正是这条路径）。
 *
 *  窗口取 80ms：同一枚物理按键里 compositionend → keydown 的间隔在几十毫秒内，
 *  而人手两次独立按键远大于它。取舍方向明确——宁可漏一次确认（再按一下即可），
 *  不可误提交（答案已经发出去了）。 */
export const IME_CONFIRM_GRACE_MS = 80

/** 这一枚回车是不是输入法用来确认上屏的（应当吞掉，不提交）。
 *
 *  `compositionEndedAt` 是调用方 ref 里记的 compositionend 时刻（`Date.now()`），
 *  从未组合过就是 0。`now` 只为测试留注入点。
 *
 *  判据收结构体而非 DOM 事件：vitest 跑在 node 环境（无 DOM），结构化入参让纯
 *  函数侧可测。 */
export function isImeConfirmKey(
  e: { isComposing?: boolean; keyCode?: number },
  compositionEndedAt: number,
  now: number = Date.now()
): boolean {
  if (e.isComposing) return true
  if (e.keyCode === 229) return true
  return compositionEndedAt > 0 && now - compositionEndedAt <= IME_CONFIRM_GRACE_MS
}
