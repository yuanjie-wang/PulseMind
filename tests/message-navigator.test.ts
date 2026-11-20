// ── 定位我的消息：悬浮导航组的纯逻辑 + 接线扫描（PLAN-message-navigator）──
//
// 交互第二轮（用户裁定 2026-10-04）：第一轮的搜索浮层否决，改为悬浮按钮
// 组——回到底部（输入区水平居中上方）+ 上/下一条用户消息步进对（右侧），
// 全部只在对话区离开底部时出现。覆盖分工：
//
//   - listUserPrompts 的过滤规则（哪些消息算「我发送的」）是纯函数，直接
//     驱动真实消息数组断言；
//   - 步进的目标选择是点击时的视口实测（不维护光标）。算法本体只摸
//     window/document 两个全局（2026-11-20 迁入 message-navigator 纯逻辑
//     层），node 环境注入桩 rect 即可直驱——布局事实仍是桩，被钉的是决策
//     逻辑（居中参照、边缘最近、懒加载边界的 up 回落）；
//   - 接线（统一跳转 effect 双源、topSlot 组合、回到底部重接跟随）按源码
//     扫描断言——这些是「顺序/位置不变量」，挂载测试看不到。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMessage } from '../src/renderer/src/types/agent'
import { listUserPrompts, measureStepTarget, type UserPromptAnchor } from '../src/renderer/src/components/chat/message-navigator'

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

// measureStepTarget 只摸 window.innerHeight 与 document.getElementById 两个
// 全局：node 环境下注入桩即可直驱算法。rect 由测试给定——被钉的是决策
// 逻辑，不是布局事实。用完恢复，避免污染同文件其他用例的全局面。
interface StepRect {
  top: number
  bottom: number
}

function withViewport(rects: Record<string, StepRect | null>, run: () => void): void {
  const g = globalThis as Record<string, unknown>
  const prevWindow = g.window
  const prevDocument = g.document
  g.window = { innerHeight: 800 }
  g.document = {
    getElementById: (id: string) => {
      const rect = rects[id.replace(/^chat-msg-/, '')]
      return rect ? { getBoundingClientRect: () => rect } : null
    },
  }
  try {
    run()
  } finally {
    if (prevWindow === undefined) delete g.window
    else g.window = prevWindow
    if (prevDocument === undefined) delete g.document
    else g.document = prevDocument
  }
}

describe('measureStepTarget — 视口实测选目标', () => {
  const anchors: UserPromptAnchor[] = [
    { id: 'u1', anchorId: 'u1' },
    { id: 'u2', anchorId: 'u2' },
    { id: 'u3', anchorId: 'u3' },
    { id: 'u4', anchorId: 'u4' },
    { id: 'u5', anchorId: 'u5' },
  ]

  it('视口内有可见用户消息：目标 = 最接近视口中心那条的同向邻位', () => {
    withViewport({ u2: { top: 300, bottom: 360 }, u3: { top: 380, bottom: 440 }, u4: { top: 700, bottom: 760 } }, () => {
      // u3 的元素中心 410 最接近视口中心 400 → up 取 u2、down 取 u4
      expect(measureStepTarget(anchors, -1)).toBe(1)
      expect(measureStepTarget(anchors, 1)).toBe(3)
    })
  })

  it('居中那条已是第一条：up 到头置灰（-1），down 正常', () => {
    withViewport({ u1: { top: 390, bottom: 450 }, u2: { top: 900, bottom: 960 } }, () => {
      expect(measureStepTarget(anchors, -1)).toBe(-1)
      expect(measureStepTarget(anchors, 1)).toBe(1)
    })
  })

  it('懒加载边界（2026-11-20 实锤的置灰死态）：已挂载锚全在视口下方且上方还有未挂载历史 → up 命中首条已挂载锚的前一条', () => {
    // u1、u2 在窗口之外（getElementById null），u3..u5 已挂载但全在视口
    // 下方——视口停在渲染窗口顶部附近、新 prepend 的一页里没有用户消息。
    // 旧算法三分支全落空（不可见 + 无边缘锚 + mountedSeen 堵死 fallback）
    // → 恒 -1；现在目标指向未挂载的 u2，宿主扩窗机制负责挂载它再滚动。
    withViewport({ u3: { top: 900, bottom: 960 }, u4: { top: 1200, bottom: 1260 }, u5: { top: 1500, bottom: 1560 } }, () => {
      expect(measureStepTarget(anchors, -1)).toBe(1)
      // down 不受影响：视口下方最近的是 u3
      expect(measureStepTarget(anchors, 1)).toBe(2)
    })
  })

  it('同上但首条已挂载锚就是第一条：up 真没有更早的用户消息，置灰', () => {
    withViewport({ u1: { top: 900, bottom: 960 }, u2: { top: 1200, bottom: 1260 } }, () => {
      expect(measureStepTarget(anchors, -1)).toBe(-1)
    })
  })

  it('一条都没挂载（全部在窗口之上）：up 取最后一条，down 无处可去', () => {
    withViewport({}, () => {
      expect(measureStepTarget(anchors, -1)).toBe(4)
      expect(measureStepTarget(anchors, 1)).toBe(-1)
    })
  })

  it('视口内无可见、上方有已挂载锚：取刚越过视口顶最近的一条', () => {
    withViewport({ u1: { top: -500, bottom: -440 }, u2: { top: -100, bottom: -40 }, u4: { top: 900, bottom: 960 } }, () => {
      // u2 的 rect.bottom 最大（离视口顶最近）
      expect(measureStepTarget(anchors, -1)).toBe(1)
    })
  })

  it('down 对称：视口内无可见、下方有已挂载锚 → 取刚越过视口底最近的一条', () => {
    withViewport({ u1: { top: -500, bottom: -440 }, u3: { top: 850, bottom: 910 }, u5: { top: 1300, bottom: 1360 } }, () => {
      // u3 的 rect.top 最小（离视口底最近）
      expect(measureStepTarget(anchors, 1)).toBe(2)
    })
  })
})

describe('接线扫描 — ChatView × 悬浮导航组', () => {
  const chatView = readFileSync(join(ROOT, 'src/renderer/src/components/layout/ChatView.tsx'), 'utf8')
  // PLAN-layout-modes：composer 的 topSlot 交付点（InputArea 挂载）随抽取搬进
  // ChatBody——两个宿主（主卡 / 侧栏 dock）渲染同一份。
  const chatBody = readFileSync(join(ROOT, 'src/renderer/src/components/chat/ChatBody.tsx'), 'utf8')
  const controls = readFileSync(join(ROOT, 'src/renderer/src/components/chat/MessageNavigator.tsx'), 'utf8')
  // The tail-follow engine the hosts now share; several invariants below used to
  // live in ChatView's own geometry and moved here with it.
  const tailFollow = readFileSync(join(ROOT, 'src/shared/tail-follow.ts'), 'utf8')

  it('显隐翻面由引擎的跟随状态驱动（几何读数退役）', () => {
    // 旧不变量是「isNearBottomRef 写入 → 翻面 → 早退」的顺序。翻面改由
    // tail-follow 引擎广播意图状态：引擎判定即 setState，不存在「早退之后
    // 的滚动事件读到过期几何」这一类顺序问题（landing/suppress 仍在引擎之外，
    // 由 jump 的 hold 窗口表达）。
    expect(chatView).toContain('onFollowingChange: (f) => setAwayFromBottom(!f)')
    expect(chatView).toContain('useTailFollow(() => scrollRef.current')
    // 几何判定的写入点退役——它正是「一次大增高把自己关掉」与「吸附带」的来源
    expect(chatView).not.toContain('isNearBottomRef.current = nearBottom')
  })

  it('统一跳转 effect 同时消费 plan 与 nav 两个跳转源', () => {
    expect(chatView).toContain('planScrollToMsgId ?? navJump?.id')
    expect(chatView).toContain('<MessageNavControls')
  })

  it('topSlot 组合悬浮导航组（回到底部 + 步进对）', () => {
    expect(chatBody).toContain('topSlot={navTopSlot}')
    expect(chatBody).not.toContain('topSlot={planStrip}')
    expect(chatView).toContain('onJumpToBottom={jumpToBottom}')
    expect(chatView).toContain('onJumpPrompt={handleNavJump}')
    expect(chatView).toContain('prompts={userPrompts}')
  })

  it('步进目标测算住在纯逻辑层，组件点击与置灰共用同一份（2026-11-20 迁出组件）', () => {
    const nav = readFileSync(join(ROOT, 'src/renderer/src/components/chat/message-navigator.ts'), 'utf8')
    expect(nav).toContain('export function measureStepTarget')
    expect(nav).toContain('targetIdx = currentIdx + dir')
    expect(nav).toContain('targetIdx = edgeIdx')
    // 懒加载边界死态的修复分支：视口在全部已挂载锚之上时，up 指向首条
    // 已挂载锚的前一条（未挂载历史，宿主扩窗兜底）；一条都没挂载回落末条
    expect(nav).toContain('targetIdx = mountedSeen ? firstMountedIdx - 1 : prompts.length - 1')
    expect(nav).toContain('const past = dir === -1 ? -rect.bottom : rect.top - window.innerHeight')
    // 组件不再自带算法：四处调用（置灰重算 up/down + 两个点击处理器）吃同一份
    expect(controls).toContain("import { measureStepTarget, type UserPromptAnchor } from './message-navigator'")
    expect(controls).not.toContain('export function measureStepTarget')
    expect(controls.match(/measureStepTarget\(prompts/g)?.length).toBe(4)
  })

  it('跳转请求先剥 __后缀再查锚点映射——带后缀的消息 id 才能走通扩窗/滚动路径', () => {
    // msgIdToAnchorRef 的键与 DOM 锚都是剥后缀形态；navigator 递的是原始
    // AgentMessage.id——不剥就 map、DOM 双双 miss，扩窗静默放弃（步进现在
    // 会把点击送达未挂载目标，这条路径必须通）。
    expect(chatView).toContain("msgIdToAnchorRef.current.get(requested.replace(/__\\w+$/, ''))")
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
    // 回到底部走引擎的 jump()：跟随由意图持有，不再手写 isNearBottomRef；
    // 平滑滚动的落点仍固定在点击瞬间（写点在引擎内）。
    expect(chatView).toMatch(/const jumpToBottom = useCallback/)
    expect(chatView).toMatch(/const jumpToBottom = useCallback\(\(\) => \{[\s\S]{0,1200}follow\.jump\(\)/)
    expect(tailFollow).toContain("el.scrollTo({ top, behavior: 'smooth' })")
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

  it('planStrip 左对齐到输入卡左缘（COMPOSER_MAX_WIDTH 卡框收缩，2026-11-08 裁定）', () => {
    // prettier 按列宽把这段 JSX 折单行/展开多行（7a4c28e 同款教训）：钉
    // 「planStrip 包在限宽 div 里」的结构，空白与括号形状不进断言。
    expect(chatView).toMatch(/\{planStrip &&\s*\(?\s*<div style=\{\{ maxWidth: 952/)
    expect(chatView).toContain("maxWidth: 952, margin: '0 auto', display: 'flex', justifyContent: 'flex-start'")
    expect(chatView).not.toMatch(/stripAbove=/)
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
    // prettier 把链式调用拆成多行——对空白鲁棒。
    expect(chatView).toMatch(/\.filter\(isUserPromptMessage\)\s*\.map\(\(m\) => m\.id\)\s*\.join\(/)
    expect(chatView).toContain('[promptIdsKey]')
    const nav = readFileSync(join(ROOT, 'src/renderer/src/components/chat/message-navigator.ts'), 'utf8')
    expect(nav).toContain('export function isUserPromptMessage')
    expect(nav).toContain('if (!isUserPromptMessage(msg)) continue')
  })

  it('回到底部落地后由引擎继续钉住尾巴——流式追高不再停在旧底部脱钩跟随（review_20261006 中4）', () => {
    // 平滑滚动的落点固定于点击瞬间；落地后必须继续跟随真实底部，否则流式追高
    // 时最后一次滚动事件把跟随翻掉、停在旧底部。现在由引擎负责：jump() 记下
    // holdUntil，动画期间的中间位置不算用户滚动；hold 到期后 settle 循环接管。
    expect(chatView).toContain('follow.jump()')
    expect(tailFollow).toContain('holdUntil = now() + jumpHoldMs')
    expect(tailFollow).toMatch(/if \(now\(\) < holdUntil\) \{\s*\n\s*frameHandle = schedule\(step\)/)
    // 动画窗口内的滚动事件不得翻掉跟随
    expect(tailFollow).toContain('if (held || now() < holdUntil) return')
    // 旧的二次钉底 pinner 随引擎退役（其清理点也必须一并消失）
    expect(chatView).not.toContain('jumpPinCancelRef')
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
