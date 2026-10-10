import type { MouseEvent as ReactMouseEvent } from 'react'

/** 安全动作按钮只认真实用户手势（full_20261011 M13-P0-1）：React 不检查
 *  isTrusted，页面脚本对任意节点合成 `click()` 照常触发 onClick。授权级别
 *  切换、批准/拒绝工具调用、循环上限续跑——这些动作决定「模型能否放行」
 *  与「会话怎么配置」，一律先过这里；合成事件（isTrusted=false）被静默
 *  忽略。Shadow Root 已 closed（content/index.tsx），这是合成节点引用从
 *  其它路径泄漏时的第二道闸。
 *
 *  自动化注意：CDP/Playwright 的真实输入事件是 trusted，探针不受影响；
 *  jsdom 派发的事件 isTrusted=false，单测要驱动这些按钮需直接调回调。 */
export function trustedOnly(e: ReactMouseEvent): boolean {
  return e.nativeEvent.isTrusted === true
}
