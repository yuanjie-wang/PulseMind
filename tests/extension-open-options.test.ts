// ── 面板「打开设置」按钮的接线 ──
// openOptionsPage 在 content script 的 chrome.runtime 上不是受限而是**缺席**
// （实测 Chromium 153，属性 undefined）——直调抛 TypeError，且 openOptions 的
// catch 把它吞成「点了没反应」（user report 2026-10-09 的静默死按钮根因）。
// 调用必须经 OPEN_OPTIONS_MESSAGE_TYPE 路由到 service worker。vitest 起不了
// chrome 语境，这里用源码扫描钉接线形状；真实浏览器的端到端验收在
// scripts/probe-panel-open-options.mjs（负向控制已验：直调回去恰好红在
// 「点击未打开 options 页」）。每条扫描都写明非空条件。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const SHARED_BRIDGE = read('src', 'extension', 'bridge.ts')
const CONTENT_BRIDGE = read('src', 'extension', 'content', 'bridge.ts')
const BACKGROUND = read('src', 'extension', 'background', 'index.ts')

describe("the panel's 打开设置 button routes through the service worker", () => {
  it('the shared channel declares the message type', () => {
    // Non-vacuous: renaming the constant or the wire literal fails the two
    // consumer scans below instead of leaving them matched to a dead string.
    expect(SHARED_BRIDGE).toMatch(/export const OPEN_OPTIONS_MESSAGE_TYPE = 'pulsemind\/open-options'/)
  })

  it('the content script sends the message and never calls openOptionsPage directly', () => {
    // The regression shape is a `chrome.runtime.openOptionsPage` access in
    // content/bridge.ts — absent property, silently swallowed, dead button.
    // The bare word is allowed in prose (the function's own doc comment names
    // the API to explain the routing); only the chrome.runtime member access
    // is forbidden. Non-vacuous: reverting to the direct call fails BOTH the
    // sendMessage scan and the access-absence scan.
    expect(CONTENT_BRIDGE).toContain('OPEN_OPTIONS_MESSAGE_TYPE')
    expect(CONTENT_BRIDGE).toContain('sendMessage({ type: OPEN_OPTIONS_MESSAGE_TYPE })')
    expect(CONTENT_BRIDGE).not.toContain('chrome.runtime.openOptionsPage')
  })

  it('the service worker answers the message with openOptionsPage', () => {
    // Non-vacuous: deleting the handler branch fails the branch scan; a branch
    // that no longer calls the API fails the compound match.
    expect(BACKGROUND).toContain('OPEN_OPTIONS_MESSAGE_TYPE')
    expect(BACKGROUND).toMatch(
      /msg\?\.type === OPEN_OPTIONS_MESSAGE_TYPE[\s\S]{0,300}chrome\.runtime\.openOptionsPage\(\)/,
    )
  })
})
