// ── One sub-agent session view, and the spawn card's way into it ──
// 「子代理的执行过程已经能够使用对话视图展示了」 was true of the plan DAG node
// (PLAN-workbench W12) and false of the spawn card, whose eye opened a
// hand-rolled preview Modal: its own bubbles, its own markdown, a ContextRing
// and a blinking cursor. That was a second message renderer (AGENTS.md: the
// project has exactly one conversation UI), it had no test and no probe, and it
// was structurally capped at one level — a sub-conversation is read back from
// the DB without the wire fields, so a nested spawn card has no subConvId to
// offer. The Modal is deleted; the card's eye now hands (subConvId, title) up to
// the App, which opens the SAME SubAgentSessionView the DAG drill-in uses.
//
// What each half can be pinned by: the title composition is pure
// (tests/tool-summary.test.ts), the real click and the card staying shut are DOM
// (scripts/probe-subagent-session.mjs drives a mouse onto the eye) — and the
// prop threading plus the two App-level invariants are wiring. vitest here is
// node-env with no jsdom and no @testing-library, so the hooks and the chat
// cannot be mounted, which is why this file asserts them against the sources, as
// tests/pending-approval.test.ts and tests/expert-delegation.test.ts do for
// their own orderings.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const SRC = join(REPO, 'src')
const R = (...p: string[]) => join(SRC, 'renderer', 'src', ...p)

const MESSAGE_GROUP = R('components', 'chat', 'MessageGroup.tsx')
const EXECUTION_SEGMENT = R('components', 'chat', 'ExecutionSegment.tsx')
const SEGMENT_VIEW = R('components', 'chat', 'SegmentView.tsx')
const CHAT_VIEW = R('components', 'layout', 'ChatView.tsx')
const WORKBENCH_PANE = R('components', 'workbench', 'WorkbenchPane.tsx')
const APP = R('App.tsx')

const read = (path: string) => readFileSync(path, 'utf-8')
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

/** Every .ts/.tsx under src/ — the tree the deleted Modal must not come back to. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

describe('the spawn card opens the one sub-agent session view', () => {
  const groupSrc = read(MESSAGE_GROUP)

  it('shows the entry only for a spawn that has an ID and a host that can open it', () => {
    expect(groupSrc).toContain('const subConvId = block.subConvId')
    // The two optional halves are the rule that keeps a read-only host (the
    // expert editor's preview, the routine workspace, the tool studio) from
    // showing a dead eye: it renders only when the host supplied the handler.
    expect(groupSrc).toContain(
      "const canOpenSession = block.name === 'spawn_agent' && !!subConvId && !!onOpenSubAgent"
    )
    // Non-vacuity: the eye itself is still rendered.
    expect(groupSrc).toContain('data-open-subagent={subConvId}')
    expect(groupSrc).toContain('title="查看子代理会话"')
  })

  it('hands off the ID and the card\u2019s own title, without collapsing the card', () => {
    const from = groupSrc.indexOf('data-open-subagent={subConvId}')
    const eye = groupSrc.slice(from, groupSrc.indexOf('</span>', from))
    const stop = eye.indexOf('e.stopPropagation()')
    const call = eye.indexOf('onOpenSubAgent!(subConvId!, subAgentSessionTitle(block))')

    expect(stop).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(stop)
    // The header's own onClick toggles the card, and the eye sits inside it: a
    // hand-off without the stop would open the session *and* expand the card.
    expect(eye.slice(0, call)).toContain('e.stopPropagation()')
  })

  it('threads the hand-off through all five hops', () => {
    // The prop is optional at every hop, so the four other SegmentView hosts
    // (form assist, routine workspace, tool studio, expert editor) keep the
    // card exactly as it was — which is asserted by the scan below.
    const hops: Array<[string, string, number]> = [
      [MESSAGE_GROUP, 'onOpenSubAgent={onOpenSubAgent}', 1],
      [EXECUTION_SEGMENT, 'onOpenSubAgent={props.onOpenSubAgent}', 1],
      [SEGMENT_VIEW, 'onOpenSubAgent={onOpenSubAgent}', 2], // execution + single block
      [CHAT_VIEW, 'onOpenSubAgent={onOpenSubAgent}', 1],
      [APP, 'onOpenSubAgent={onOpenSubAgent}', 1],
    ]
    for (const [path, expr, times] of hops) {
      const src = read(path)
      expect(count(src, expr), `${path} forwards ${expr}`).toBe(times)
    }
    const declares: Array<[string, number]> = [
      [MESSAGE_GROUP, 2], // CollapsibleToolBlock + MessageGroup
      [EXECUTION_SEGMENT, 1],
      [SEGMENT_VIEW, 1],
      [CHAT_VIEW, 1],
    ]
    for (const [path, times] of declares) {
      const src = read(path)
      expect(
        count(src, 'onOpenSubAgent?: (subConvId: string, title: string) => void'),
        `${path} declares the optional prop`
      ).toBe(times)
    }
    expect(read(APP)).toContain('const onOpenSubAgent = useCallback((subConvId: string, title: string) => {')
  })

  it('keeps the handler in the segment renderer\u2019s deps (a stale one would drop the click)', () => {
    // renderSegment is a useCallback handed to every segment; without the dep
    // the expanded segments keep the first render's handler. prettier 竖排 deps
    // 数组——末项 + 收括号对空白鲁棒。
    expect(read(CHAT_VIEW)).toMatch(/onOpenSubAgent,\s*\]/)
  })

  it('reaches no host that did not ask for it', () => {
    const mentioned = sourceFiles(SRC)
      .filter((path) => read(path).includes('onOpenSubAgent'))
      .map((path) => path.slice(SRC.length + 1))
      .sort()

    expect(mentioned).toEqual([
      'renderer/src/App.tsx',
      'renderer/src/components/chat/ExecutionSegment.tsx',
      'renderer/src/components/chat/MessageGroup.tsx',
      'renderer/src/components/chat/SegmentView.tsx',
      'renderer/src/components/layout/ChatView.tsx',
      // The popout window hosts the same drill-in overlay (PLAN-conversation-
      // popout): it is the second caller of onOpenSubAgent, deliberately.
      'renderer/src/popout/PopoutApp.tsx',
    ])
  })

  it('renders no transcript of its own any more', () => {
    // The pieces of the deleted Modal. Any one of them back means the card grew
    // a second message renderer again.
    for (const dead of [
      '<Modal',
      'hydrateConversation',
      'estimateContextUsed',
      'pulsemind-blink-cursor',
      'subContextUsed',
      'previewRunning',
      'pollRef',
      'previewConv',
      'contextLength',
    ]) {
      expect(groupSrc, `MessageGroup still carries ${dead}`).not.toContain(dead)
    }
    // The only transcript reader on this path is the session view.
    expect(read(R('components', 'subagent', 'SubAgentSessionView.tsx'))).toContain(
      'window.electronAPI.hydrateConversation(subConvId)'
    )
  })

  it('deleted the hand-rolled preview from the whole tree', () => {
    const leftovers = sourceFiles(SRC).filter((path) => read(path).includes('子代理对话'))
    // The DAG's own title says 子代理会话; 对话 was the Modal's, and nothing
    // else ever wrote it.
    expect(leftovers).toEqual([])
  })

  it('opens one view from two doors, with liveness derived rather than stored', () => {
    const appSrc = read(APP)

    expect(count(appSrc, '<SubAgentSessionView')).toBe(1)
    expect(appSrc).toContain('live={subAgentLive}')
    expect(appSrc).toContain("{ kind: 'plan'; nodeId: string; subConvId: string; title: string }")
    expect(appSrc).toContain("{ kind: 'spawn'; subConvId: string; title: string }")
    // Both doors, plus the reset when the conversation changes and the back
    // button.
    expect(count(appSrc, 'setSubAgentView(')).toBe(4)

    // `live` is a derivation, never a click-time snapshot: as a state it would
    // keep the 运行中 badge, viewOnly actions and the 2s poll after the run
    // settled (W12 paid for exactly that).
    expect(appSrc).toContain('const subAgentLive = useMemo(')
    expect(appSrc).not.toContain('const [subAgentLive')
    expect(appSrc).toContain('?.status === \'pending\'')
    expect(appSrc).toMatch(/b\.subConvId === subAgentView\.subConvId/)
    expect(appSrc).toMatch(/b\.status === 'running' \|\| b\.status === 'queued' \|\| b\.status === 'pending'/)
  })

  // User ruling 2026-09-25: 主对话打开了侧边窗口，进入子对话中也要打开 —
  // the drill-in overlays the chat COLUMN only. That has two halves, both
  // wiring (node-env can't mount App): ChatView must stay PAINTED (its
  // display:none also hid the docked WorkbenchPane along with the chat), and
  // the overlay must stop at the pane's left edge — the same
  // openByConversation[wbKey] expression ChatView/WorkbenchPane read, so the
  // paddingRight reserve and the overlay's right inset can't disagree.
  it('keeps the chat pane painted under the drill-in and cuts the overlay at the docked workbench', () => {
    const appSrc = read(APP)

    expect(appSrc).not.toContain("display: subAgentView ? 'none'")
    // 卡片化（2026-11-03）：右缘 = clamp 后的 pane 宽 + 卡边距 + 列间 gap——
    // 与 ChatView 的 reserve 同一把 clampPaneWidth 尺（旧表达式用 raw
    // workbenchWidth，存储宽大于今日 chatArea 时覆盖层越过对话列压到 pane）。
    expect(appSrc).toContain('clampPaneWidth(workbenchWidth, chatAreaWidth) + WORKBENCH_CARD_MARGIN * 2')
    expect(appSrc).toContain('openByConversation[wbKey] ?? false')
    expect(appSrc).toContain('const wbKey = activeConvKey ?? DRAFT_CONVERSATION_KEY')
    // The workbench reads its own open flag through the identical expression —
    // if one side ever keys differently the overlay starts covering the dock.
    expect(read(WORKBENCH_PANE)).toContain('s.openByConversation[key] ?? false')
  })

  // The other ruling: 子对话需要和主对话一样有个闪烁光标. TranscriptView blinks
  // StreamingCursor on isRequesting alone (agentStatus stays idle — no engine
  // handle here), so the view must thread live into it — minus the frozen-tree
  // gate: 停止 → awaiting_continue keeps the blocks reading running, and the
  // cursor must NOT blink over paused work (App derives `paused`).
  it('threads the live flag into the transcript as isRequesting', () => {
    expect(read(R('components', 'subagent', 'SubAgentSessionView.tsx')))
      .toContain('isRequesting={live && !paused && !loading}')
    // The hook the DOM tests/probe key on. The glyph lives in StreamingCaret
    // (shared with SegmentView's in-text streaming tail since 2026-10-26), and
    // the foot cursor must still draw it.
    expect(read(R('components', 'chat', 'StreamingCaret.tsx')))
      .toContain('data-streaming-cursor=')
    expect(read(R('components', 'chat', 'StreamingCursor.tsx')))
      .toContain('<StreamingCaret />')
  })

  // Third ruling of the same pass: 输出流的尾部会被输入框遮挡，应该要把输入框隐藏.
  // The floating Composer is absolute with zIndex 10 INSIDE ChatView's relative
  // root, so with ChatView now painted it drew ABOVE the drill-in overlay
  // (z-auto) and covered the sub-agent session's tail. The fix is suppression,
  // not a z-index war: App passes the flag, ChatView threads it, InputArea's
  // root goes display:none — mounted, never unmounted, so the draft survives.
  // All wiring (node-env can't mount any of the three); the observable
  // visibility + draft half lives in scripts/probe-chat-deliverables.mjs.
  it('suppresses the main composer while the drill-in covers the chat column', () => {
    expect(read(APP)).toContain('hideComposer={!!subAgentView}')

    const chatSrc = read(CHAT_VIEW)
    expect(chatSrc).toContain('hideComposer?: boolean')
    expect(chatSrc).toContain('hideComposer,')
    // PLAN-layout-modes：InputArea 挂载（hidden 交付点）随抽取搬进 ChatBody。
    expect(read(R('components', 'chat', 'ChatBody.tsx'))).toContain('hidden={hideComposer}')

    const inputSrc = read(R('components', 'chat', 'InputArea.tsx'))
    expect(inputSrc).toContain('display: hidden ? \'none\' : undefined')
    // The reason the hide exists at all: pin the floating root's z-index, the
    // fact that made the composer paint over a z-auto overlay. Whitespace-
    // tolerant: the object went multi-line when the root went click-through.
    expect(read(R('components', 'chat', 'Composer.tsx'))).toMatch(
      /position:\s*'absolute',\s*bottom:\s*0,\s*left:\s*0,\s*right:\s*0,\s*zIndex:\s*10/,
    )
  })
})
