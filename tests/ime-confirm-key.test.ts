/** ask_user 自定义回答输入框的 IME 守卫（用户实测 bug：中文拼音模式下打英文、
 *  按回车确认上屏，答案被直接发了出去）。
 *
 *  这里钉的是判据本身——三层各自的拦截面，以及「普通回车必须照旧提交」这条
 *  反向保险：守卫放宽成什么都不敢提交，bug 就换了个方向。 */
import { describe, expect, it } from 'vitest'
import { IME_CONFIRM_GRACE_MS, isImeConfirmKey } from '../src/shared/ui/ime'

const T0 = 1_700_000_000_000

describe('isImeConfirmKey', () => {
  it('L1：组合进行中的回车是输入法确认（Chromium 主流路径）', () => {
    expect(isImeConfirmKey({ isComposing: true, keyCode: 13 }, 0, T0)).toBe(true)
  })

  it('L2：keyCode 229 是输入法在处理该按键的兜底（isComposing 已为 false）', () => {
    expect(isImeConfirmKey({ isComposing: false, keyCode: 229 }, 0, T0)).toBe(true)
  })

  it('L3：compositionend 紧邻的那枚回车被窗口吞掉（macOS 的穿透路径）', () => {
    expect(isImeConfirmKey({ isComposing: false, keyCode: 13 }, T0, T0 + 5)).toBe(true)
    // 边界本身仍算窗口内——同一枚按键的 compositionend → keydown 间隔只有几毫秒
    expect(isImeConfirmKey({ isComposing: false, keyCode: 13 }, T0, T0 + IME_CONFIRM_GRACE_MS)).toBe(true)
  })

  it('L3 之外：组合早已结束的普通回车照旧提交', () => {
    expect(isImeConfirmKey({ isComposing: false, keyCode: 13 }, T0, T0 + IME_CONFIRM_GRACE_MS + 1)).toBe(false)
  })

  it('从未组合过输入框（纯英文/数字）回车照旧提交', () => {
    expect(isImeConfirmKey({ isComposing: false, keyCode: 13 }, 0, T0)).toBe(false)
    expect(isImeConfirmKey({}, 0, T0)).toBe(false)
  })
})
