// ── 定位我的消息：悬浮导航组的纯逻辑 + 接线扫描（PLAN-message-navigator）──
//
// 交互第二轮（用户裁定 2026-10-04）：第一轮的搜索浮层否决，改为悬浮按钮
// 组——回到底部（输入区水平居中上方）+ 上/下一条用户消息步进对（右侧），
// 全部只在对话区离开底部时出现。覆盖分工：
//
//   - listUserPrompts 的过滤规则（哪些消息算「我发送的」）是纯函数，直接
//     驱动真实消息数组断言；
//   - 步进的目标选择是点击时的视口实测（不维护光标），属 DOM/布局事实，
//     vitest 够不到，只按源码钉住算法的关键裁决（早退之前翻面、严格以视
//     口中心为界、未挂载锚的 up 回落）；
//   - 接线（统一跳转 effect 双源、topSlot 组合、回到底部重接跟随）按源码
//     扫描断言——这些是「顺序/位置不变量」，挂载测试看不到。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '../src/renderer/src/types/agent'
import { listUserPrompts } from '../src/renderer/src/components/chat/message-navigator'

const ROOT = join(__dirname, '..')

function msg(id: string, role: 'user' | 'assistant', text: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id,
    role,
    contentBlocks: [{ type: 'text', text }],
    createdAt: new Date(2026, 9, 4, 12, 0).toISOString(),
    ...extra,
  }
}

describe('listUserPrompts — 哪些消息算「我发送的」', () => {
  it('只列无 tool_result、非 autoSummary、有正文的用户消息，保持会话顺序', () => {
    const anchors = listUserPrompts([
      msg('a1', 'assistant', '你好，我是助手'),
      msg('u1', 'user', '第一个需求'),
      // 执行段内部回传结果的伪用户消息——不列
      { ...msg('t1', 'user', ''), contentBlocks: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      msg('u2', 'user', '第二个需求'),
      // 历史摘要注入的伪用户消息——不列
      msg('sum1', 'user', '（历史摘要）', { autoSummary: true }),
      msg('u3', 'user', '第三个需求'),
    ])
    expect(anchors.map((a) => a.id)).toEqual(['u1', 'u2', 'u3'])
  })

  it('纯附件消息（文本即 [file:]/[folder:] 引用）照列；全空消息不列', () => {
    const anchors = listUserPrompts([
      msg('u1', 'user', '[file:/tmp/a.log] [folder:/tmp/b]'),
      msg('u2', 'user', '   '),
      { ...msg('u3', 'user', ''), contentBlocks: [{ type: 'text', text: '' }] },
    ])
    expect(anchors.map((a) => a.id)).toEqual(['u1'])
  })

  it('锚点 id 剥离 __后缀，跳转请求 id 保留原样', () => {
    const anchors = listUserPrompts([msg('abc__staged', 'user', 'hello')])
    expect(anchors[0].id).toBe('abc__staged')
    expect(anchors[0].anchorId).toBe('abc')
  })
})

describe('接线扫描 — ChatView × 悬浮导航组', () => {
  const chatView = readFileSync(join(ROOT, 'src/renderer/src/components/layout/ChatView.tsx'), 'utf8')
  const controls = readFileSync(join(ROOT, 'src/renderer/src/components/chat/MessageNavigator.tsx'), 'utf8')

  it('显隐翻面在 handleScroll 的 landing/suppress 早退之前', () => {
    const setIdx = chatView.indexOf('setAwayFromBottom(')
    const nearIdx = chatView.indexOf('isNearBottomRef.current = nearBottom')
    const earlyReturnIdx = chatView.indexOf('landingRef.current || suppressJumpScrollRef.current')
    // 顺序不变量：isNearBottomRef 写入 → 显隐翻面 → 早退。早退之后的滚动事
    // 件（平滑跳转期间被拦）不会带走显隐，跳转结束后不会停在过期状态。
    expect(nearIdx).toBeGreaterThanOrEqual(0)
    expect(setIdx).toBeGreaterThan(nearIdx)
    expect(earlyReturnIdx).toBeGreaterThan(setIdx)
    expect(chatView).toContain('setAwayFromBottom((prev) => (prev === !nearBottom ? prev : !nearBottom))')
  })

  it('统一跳转 effect 同时消费 plan 与 nav 两个跳转源', () => {
    expect(chatView).toContain('planScrollToMsgId ?? navJump?.id')
    expect(chatView).toContain('<MessageNavControls')
  })

  it('topSlot 组合悬浮导航组（回到底部 + 步进对）', () => {
    expect(chatView).toContain('topSlot={navTopSlot}')
    expect(chatView).not.toContain('topSlot={planStrip}')
    expect(chatView).toContain('onJumpToBottom={jumpToBottom}')
    expect(chatView).toContain('onJumpPrompt={handleNavJump}')
    expect(chatView).toContain('prompts={userPrompts}')
  })

  it('步进目标测算住在组件里，点击与渲染共用一份', () => {
    expect(controls).toContain('export function measureStepTarget')
    expect(controls).toContain('targetIdx = currentIdx + dir')
    expect(controls).toContain('targetIdx = edgeIdx')
    expect(controls).toContain('targetIdx = prompts.length - 1')
    expect(controls).toContain('const past = dir === -1 ? -rect.bottom : rect.top - window.innerHeight')
  })

  it('到头置灰：可用性实时重算（捕获式滚动监听），点击不再走 ChatView', () => {
    expect(controls).toContain('disabled={!canStep.up}')
    expect(controls).toContain('disabled={!canStep.down}')
    expect(controls).toContain('--pm-text-disabled')
    // 容器在宿主手里：capture 监听才收得到内层滚动（跳转的平滑滚动事件
    // 也被捕获，落点后置灰态自然刷新）
    expect(controls).toContain("document.addEventListener('scroll', onScroll, true)")
    expect(chatView).not.toContain('stepUserPrompt')
  })

  it('定位不闪高亮（设置与清除都在 plan 门里）；回到底部为平滑滚动', () => {
    // 门必须包住「设置」而不只是「清除」——上一版只门了清除，nav 跳转仍会
    // 置高亮且永不清除
    expect(chatView).toMatch(/if \(isPlan\) \{\s*\n\s*setHighlightedMsgId\(targetId\)/)
    expect(chatView.match(/setHighlightedMsgId\(targetId\)/g)?.length).toBe(1)
    expect(chatView).toMatch(/const jumpToBottom = useCallback\(\(\) => \{\s*\n\s*isNearBottomRef\.current = true/)
    expect(chatView).toContain("el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })")
  })

  it('回到底部图标为实心三角（与步进对的空心长箭头区分）', () => {
    expect(controls).toContain('<CaretDownFilled />')
    expect(controls).not.toContain('VerticalAlignBottomOutlined')
    expect(controls).toContain('<ArrowUpOutlined />')
    expect(controls).toContain('<ArrowDownOutlined />')
  })

  it('步进药丸与输入卡片右缘对齐：卡框复用 COMPOSER_MAX_WIDTH + margin auto', () => {
    // 卡片在 1000 列内 max-width 952 居中，距列缘内缩量随窗宽变化——静态
    // right 值对不齐；卡框必须复用同一常量与同一套居中数学。根框透明于指
    // 针（不挡计划条），两簇按钮恢复可点。
    expect(controls).toContain("import { COMPOSER_MAX_WIDTH } from './Composer'")
    expect(controls).toContain('maxWidth: COMPOSER_MAX_WIDTH')
    expect(controls).toContain("margin: '0 auto'")
    expect(controls).toContain("pointerEvents: 'none'")
    expect(controls.match(/pointerEvents: 'auto'/g)?.length).toBe(2)
    // 药丸 right: 0（贴卡框右缘 = 卡片右缘），不再是对不齐的任意常数
    expect(controls).toMatch(/position: 'absolute',\s*\n\s*right: 0,/)
  })

  it('planStrip 在 navTopSlot 内保持居中收缩（块级包裹会拉伸成通栏条）', () => {
    expect(chatView).toMatch(/\{planStrip && \(/)
    expect(chatView).toContain("justifyContent: 'center'")
  })

  it('回到底部按钮的底色不被 ICON_BTN 的透明背景覆盖', () => {
    // 展开顺序不变量：...ICON_BTN（自带 background: transparent）在前，
    // 显式的 elevated 底色在后——放在后面会被展开覆盖成透明。
    const spreadIdx = controls.indexOf('...ICON_BTN,')
    const bgIdx = controls.indexOf("background: 'var(--pm-elevated)'")
    expect(spreadIdx).toBeGreaterThanOrEqual(0)
    expect(bgIdx).toBeGreaterThan(spreadIdx)
  })

  it('切会话复位悬浮导航组', () => {
    expect(chatView).toContain('setAwayFromBottom(false)')
    expect(chatView).toContain('setNavJump(null)')
  })

  it('跳转 effect 依赖只挂两个跳转请求——流式 token 不再逐个重跑（review_20261006 中2）', () => {
    // 旧依赖携带 allSegments/windowTop/extraTop：每个流式 token 重跑一次，
    // 清掉再重排 100ms 定时器、同步置 suppress——连续流下步进跳转被无限推迟，
    // 迟到的落点还把用户已滚走的视口拽回来。现在扩窗续跳走 rAF。
    expect(chatView).toContain('}, [planScrollToMsgId, navJump])')
    expect(chatView).toContain('jumpSegsRef.current = allSegments')
    expect(chatView).toContain('requestAnimationFrame(() => attempt(widenRetries - 1))')
  })

  it('userPrompts 的 memo key 是 ids 签名而非 messages 引用——不击穿 InputArea 的 memo（review_20261006 中3）', () => {
    // 每条 messages_update 都换新 messages；锚点数组必须只在「哪些用户消息」
    // 变化时才换新引用。签名谓词与 listUserPrompts 同源，不漂移。
    expect(chatView).toContain('.filter(isUserPromptMessage).map((m) => m.id).join(')
    expect(chatView).toContain('[promptIdsKey]')
    const nav = readFileSync(join(ROOT, 'src/renderer/src/components/chat/message-navigator.ts'), 'utf8')
    expect(nav).toContain('export function isUserPromptMessage')
    expect(nav).toContain('if (!isUserPromptMessage(msg)) continue')
  })

  it('回到底部落地后复用 bottom-pinner——流式追高不再停在旧底部脱钩跟随（review_20261006 中4）', () => {
    // 平滑滚动的落点固定于点击瞬间；落地后必须由 pinner 钉回真实底部，
    // 否则流式追高时最后一次滚动事件把 isNearBottomRef 翻回 false、跟随脱钩。
    expect(chatView).toContain("el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })")
    expect(chatView).toContain('jumpPinCancelRef.current = startBottomPin(() => scrollRef.current, {})')
    // 切会话与卸载都要收掉这枚 pinner（与 landing 的 cancelPinRef 并列）
    expect(chatView.match(/jumpPinCancelRef\.current\?\.\(\)/g)?.length).toBe(3)
    expect(chatView).toContain('review_20261006 中4')
  })

  it('第一轮的浮层交互已移除（⌘F 监听与阈值不再存在）', () => {
    expect(chatView).not.toContain("e.key.toLowerCase() !== 'f'")
    expect(chatView).not.toContain('NAVIGATOR_MIN_MESSAGES')
    expect(chatView).not.toContain('MessageNavigatorPanel')
    // 步进对只在有用户消息时渲染；回到底部不依赖用户消息
    expect(controls).toContain('prompts.length > 0')
  })
})
