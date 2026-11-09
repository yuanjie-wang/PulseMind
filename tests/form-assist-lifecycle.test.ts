// ── Form-assist conversation lifecycle (用户裁定 2026-09-20) ──
// 每个任务/专家最多关联一个会话：会话 id 由实体决定（formAssistConversationId
// 的单槽），「新会话」丢弃旧线程后原地重来；新建流的草稿线程在首次保存时升格
// 为该实体的会话。两个表单助手（例程 / 专家）共用 session-lifecycle.ts 的全部
// 入口，本文件用 electronAPI 桩把 discard/promote 的真实顺序钉住：
//
//   · promote 必须先写实体槽、再丢弃旧槽 —— 顺序反了会在 IPC 失败时两头落空；
//   · 丢弃必须先 dispose 主进程托管会话、再删行 —— createSession 会复用已有
//     条目，只删行的话旧引擎带着旧上下文复活（工具工作室删除时同一教训）；
//   · 两步都容忍缺席（从未发送过的线程既没有会话也没有行）。
//
// vitest 是 node-env：钩子与编辑器挂载不了，渲染接线（resetKey 通道、新会话
// 按钮、两个宿主的四处接线）按本仓库惯例做源码扫描。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation } from '../src/shared/types/conversation'
import type { AgentMessage } from '../src/renderer/src/types/agent'

type Call = { method: string; args: unknown[] }

function stubElectronAPI(): { calls: Call[]; failDispose: () => void } {
  const calls: Call[] = []
  let disposeFails = false
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      agentSessionEngineCall: (id: string, method: string, args: unknown[]) => {
        if (method !== 'dispose') return Promise.resolve(null)
        calls.push({ method: 'dispose', args: [id, method, args] })
        // The failure path matters: a thread nothing was ever sent to has no
        // session, so dispose rejects — the delete must still happen.
        return disposeFails ? Promise.reject(new Error('session not found')) : Promise.resolve(null)
      },
      deleteConversation: (id: string) => {
        calls.push({ method: 'deleteConversation', args: [id] })
        return Promise.resolve()
      },
      // The whole payload is recorded, not just its id: the promoted thread's
      // TARGET and its message keys are the two things this file must pin.
      saveConversation: (conv: Conversation) => {
        calls.push({ method: 'saveConversation', args: [conv] })
        return Promise.resolve()
      },
    },
  }
  return {
    calls,
    failDispose: () => {
      disposeFails = true
    },
  }
}

const msg = (id: string): AgentMessage => ({ id, role: 'user', contentBlocks: [{ type: 'text', text: '你好' }] })

describe('discardAssistConversation', async () => {
  const { discardAssistConversation } = await import('../src/renderer/src/components/form-assist/session-lifecycle')

  it('disposes the live session BEFORE deleting the row', async () => {
    const { calls, failDispose } = stubElectronAPI()
    failDispose()
    await discardAssistConversation('expert_assist_a')
    expect(calls.map((c) => c.method)).toEqual(['dispose', 'deleteConversation'])
    expect(calls[0].args[0]).toBe('expert_assist_a')
    expect(calls[1].args[0]).toBe('expert_assist_a')
  })

  it('tolerates an absent session and an absent row', async () => {
    const { calls } = stubElectronAPI()
    await expect(discardAssistConversation('expert_assist_ghost')).resolves.toBeUndefined()
    expect(calls.map((c) => c.method)).toEqual(['dispose', 'deleteConversation'])
  })
})

describe('promoteAssistDraftToEntity', async () => {
  const { promoteAssistDraftToEntity } = await import('../src/renderer/src/components/form-assist/session-lifecycle')

  it('persists the thread on the entity’s SLOT, then discards the draft slot', async () => {
    const { calls } = stubElectronAPI()
    await promoteAssistDraftToEntity([msg('m1'), msg('m2')], 'routine', 'routine_assist_draft', 'routine_new1', '[日常助手] 周报')
    expect(calls.map((c) => c.method)).toEqual(['saveConversation', 'dispose', 'deleteConversation'])
    // formAssistConversationId('routine', 'routine_new1') — the slot the editor
    // re-binds to, and the ONLY id whose derived type keeps the thread out of
    // the chat list. A bare 'routine_new1' derives 'normal' (the report
    // 「用助手创建专家的对话出现在了历史对话列表中」).
    const conv = calls[0].args[0] as Conversation
    expect(conv.id).toBe('routine_assist_routine_new1')
    expect(conv.messages).toHaveLength(2)
    expect(conv.title).toBe('[日常助手] 周报')
    expect(calls[1].args[0]).toBe('routine_assist_draft')
    expect(calls[2].args[0]).toBe('routine_assist_draft')
  })

  it('re-keys every message for its new owner', async () => {
    const { calls } = stubElectronAPI()
    await promoteAssistDraftToEntity([msg('m1'), msg('m2')], 'expert', 'expert_assist_draft', 'expert_a', '[专家创建助手] 甲')
    const conv = calls[0].args[0] as Conversation
    const ids = conv.messages.map((m) => m.id)
    // messages.id is a global key whose owner is write-once (the upsert never
    // rewrites conversation_id), so re-saving m1/m2 would leave both owned by
    // the draft slot: the promoted conversation would insert with zero messages
    // and read back「内容不可见」. Fresh keys, one per message, scoped to the slot.
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id.startsWith('msg_expert_assist_expert_a_')).toBe(true)
  })

  it('an empty mirror promotes nothing but still discards the draft slot', async () => {
    const { calls } = stubElectronAPI()
    await promoteAssistDraftToEntity([], 'expert', 'expert_assist_draft', 'expert_new1', '[专家创建助手] 甲')
    expect(calls.map((c) => c.method)).toEqual(['dispose', 'deleteConversation'])
    expect(calls.every((c) => c.args[0] === 'expert_assist_draft')).toBe(true)
  })
})

// ── 接线（源码扫描：node-env 挂不起钩子）──

describe('session lifecycle wiring (source scan)', () => {
  const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf-8')
  const hostedSrc = read('src', 'renderer', 'src', 'hooks', 'useHostedAgentSession.ts')
  const assistHookSrc = read('src', 'renderer', 'src', 'components', 'form-assist', 'useFormAssistSession.ts')
  const columnSrc = read('src', 'renderer', 'src', 'components', 'form-assist', 'FormAssistColumn.tsx')
  const expertSrc = read('src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertEditor.tsx')
  const routineSrc = read('src', 'renderer', 'src', 'components', 'routine', 'TaskWizardPage.tsx')
  const centerSrc = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineCenter.tsx')

  it('the resetKey channel re-restores the mirror and clears the ledger', () => {
    // A bumped resetKey must re-run the subscription effect (a restore cycle
    // under the SAME convId) — not just the caller's local state. applySync
    // joined the deps with the 2026-09-29 perf rework (the coalesced sync's
    // stable apply step; resetKey 的语义不变).
    expect(hostedSrc).toContain('[convId, sync, applySync, resetKey]')
    // The auto-apply ledger and the undo bar belong to the discarded thread.
    expect(assistHookSrc).toContain('}, [resetKey])')
  })

  it('the column renders 新会话 behind a confirm that both hosts share', () => {
    expect(columnSrc).toContain('onNewSession?: () => void')
    expect(columnSrc).toContain('newSessionConfirmContent')
    expect(columnSrc).toMatch(/onNewSession && \(/)
  })

  it('ExpertEditor wires all four lifecycle points', () => {
    expect(expertSrc).toContain('onNewSession={discardBoundSession}')
    // Save promotes the bound thread into the expert's slot, then re-binds —
    // the convId switch is what makes the hook re-restore from the new slot.
    expect(expertSrc).toMatch(/await promoteAssistDraftToEntity\(/)
    // …and the target is the SPEC's slot prefix, never the raw profile.id.
    expect(expertSrc).toMatch(/promoteAssistDraftToEntity\(\s*assist\.messages,\s*EXPERT_ASSIST_SPEC\.conversationPrefix,/)
    const promote = expertSrc.indexOf('promoteAssistDraftToEntity(')
    const rebind = expertSrc.indexOf('setBoundId(profile.id)')
    expect(promote).toBeGreaterThan(-1)
    expect(rebind).toBeGreaterThan(promote)
    // Entering create mode discards the DRAFT slot explicitly (it runs before
    // the re-bind, when assistConvId still points at the old expert's slot).
    expect(expertSrc).toContain('discardBoundSession(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, null))')
    // Mounting straight into create mode is a create entry too.
    expect(expertSrc).toContain('mountedCreateRef')
    // Deleting an expert disposes the live session before the row goes.
    expect(expertSrc).toContain('await discardAssistConversation(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, profile.id))')
  })

  it('TaskWizardPage wires the same four points', () => {
    // 两 kind 各一条会话槽，新会话钮按 kind 路由到各自的 discard（2026-11-08：
    // workflow 助手不再是一发式面板，同样有线程生命周期）。
    expect(routineSrc).toMatch(/onNewSession=\{kind === 'routine' \? discardBoundSession : discardWorkflowSession\}/)
    expect(routineSrc).toMatch(/await promoteAssistDraftToEntity\(/)
    expect(routineSrc).toMatch(/promoteAssistDraftToEntity\(\s*assist\.messages,\s*ROUTINE_ASSIST_SPEC\.conversationPrefix,/)
    const promote = routineSrc.indexOf('promoteAssistDraftToEntity(')
    const rebind = routineSrc.indexOf('setBoundId(created.id)')
    expect(promote).toBeGreaterThan(-1)
    expect(rebind).toBeGreaterThan(promote)
    // The page is not remounted per switch — the boundId → null transition is
    // the create-entry trigger (startNew / 模板预填 / 提取 / 失效回退 all land there).
    expect(routineSrc).toMatch(/if \(kind !== 'routine' \|\| boundId !== null\) return[\s\S]*?discardBoundSession\(\)/)
    expect(centerSrc).toContain('await discardAssistConversation(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, routine.id))')
  })

  it('deletion cleanup no longer deletes rows without disposing the session', () => {
    // Non-vacuity: the raw deleteConversation call is exactly the shape that
    // leaves a stale engine holding the discarded thread's context.
    expect(expertSrc).not.toMatch(/deleteConversation\(formAssist/)
    expect(routineSrc).not.toMatch(/deleteConversation\(formAssist/)
  })
})

// ── 助手栏卡片壳 + 向右收起（user 2026-11-09）──
// 几何（卡片底/圆角、两栏宽度互换、拖拽、草稿不丢）属 probe-workflow-wizard
// §9；这里钉的是**形态与归属**：卡片壳是宿主 opt-in，锚点留在最外层，收起是
// 隐藏而不是卸载，专家编辑器一条路都不碰。

describe('assistant shell + collapse (source scan)', () => {
  const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf-8')
  const layoutSrc = read('src', 'renderer', 'src', 'components', 'layout', 'editor-layout.ts')
  const columnSrc = read('src', 'renderer', 'src', 'components', 'form-assist', 'FormAssistColumn.tsx')
  const wizardSrc = read('src', 'renderer', 'src', 'components', 'routine', 'TaskWizardPage.tsx')
  const expertSrc = read('src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertEditor.tsx')
  const zhSrc = read('src', 'renderer', 'src', 'i18n', 'locales', 'zh.ts')
  const enSrc = read('src', 'renderer', 'src', 'i18n', 'locales', 'en.ts')

  it('both wizard columns carry the immersive card recipe, no gray fill', () => {
    const at = (name: string): number => layoutSrc.indexOf(`export const ${name}`)
    const step = layoutSrc.slice(at('EDITOR_CARD_SURFACE'), at('EDITOR_CHAT_CARD'))
    const shell = layoutSrc.slice(at('EDITOR_ASSIST_SHELL'), at('EDITOR_ASSIST_RAIL'))
    for (const block of [step, shell]) {
      // 同一条配方：border only，底色就是页面底色（user 2026-11-09
      // 「就像沉浸模式那样的无底色圆角矩形包裹」）。
      expect(block).toContain("border: '1px solid var(--pm-separator-faint)'")
      expect(block).toContain('borderRadius: IMMERSIVE_CARD_RADIUS')
      expect(block).toContain('var(--pm-bg)')
      expect(block).not.toContain('var(--pm-fill)')
      expect(block).toContain("overflow: 'hidden'")
    }
    // 宽度归外壳（basis 460 / floor 300；拖拽覆盖 basis）。
    expect(shell).toContain("flex: '0 0 460px'")
    expect(shell).toContain('minWidth: 300')
    // 窄条与展开态同一份配方——换底色会让收起看起来像换了个控件。
    const rail = layoutSrc.slice(at('EDITOR_ASSIST_RAIL'))
    expect(rail).toContain("flex: '0 0 44px'")
    expect(rail).toContain('width: 44')
    expect(rail).toContain('borderRadius: IMMERSIVE_CARD_RADIUS')
    // 灰面留在原地给专家编辑器（它的助手就嵌在里面，双层灰毫无意义）。
    const surface = layoutSrc.slice(at('EDITOR_SURFACE'), at('EDITOR_CARD_SURFACE'))
    expect(surface).toContain('var(--pm-fill)')
  })

  it('the wizard step card uses the fill-less card, never the gray surface', () => {
    expect(wizardSrc).toContain("import { EDITOR_CARD_SURFACE } from '../layout/editor-layout'")
    expect(wizardSrc).toContain('...EDITOR_CARD_SURFACE')
    // Non-vacuity: the gray surface must be gone from this page entirely.
    expect(wizardSrc).not.toMatch(/\bEDITOR_SURFACE\b/)
  })

  it('the shell is opt-in, so the expert editor keeps its nested card', () => {
    expect(columnSrc).toContain('collapsed?: boolean')
    expect(columnSrc).toContain('onToggleCollapsed?: () => void')
    expect(columnSrc).toContain('width?: number')
    expect(columnSrc).toContain('resizing?: boolean')
    // One prop carries the whole mode: no onToggleCollapsed = no shell.
    expect(columnSrc).toContain('const framed = !!onToggleCollapsed')
    expect(columnSrc).toMatch(/if \(!framed\) \{\s*return \(\s*<div style=\{EDITOR_CHAT_CARD\} data-pm-form-assist>/)
    // Non-vacuity from the other side: the expert editor never opts in.
    expect(expertSrc).not.toContain('onToggleCollapsed')
    expect(expertSrc).not.toContain('collapsed=')
    expect(expertSrc).not.toContain('resizing=')
  })

  it('the shell IS the card, so the inner card drops its own ground', () => {
    expect(columnSrc).toContain('...(width ? { flex: `0 0 ${width}px` } : null)')
    expect(columnSrc).toContain("...(resizing ? { transition: 'none' } : null)")
    expect(columnSrc).toContain("background: 'transparent'")
    expect(columnSrc).toContain('borderRadius: 0')
  })

  it('the two columns are user-resizable through a sibling divider', () => {
    // 宽度与过渡抑制由宿主传下来：页面管几何，组件只画。
    expect(wizardSrc).toContain('width={effAssistWidth}')
    expect(wizardSrc).toContain('resizing={assistDrag.dragging}')
    // 拖拽与渲染共用同一把尺（行内容宽 − gap），助手栏贴右所以方向是 -1。
    expect(wizardSrc).toContain('clampWizardAssistWidth')
    expect(wizardSrc).toContain('direction: -1')
    expect(wizardSrc).toContain('const WIZARD_ROW_GAP = 12')
    // 分隔条是两栏的**兄弟**（卡片的 overflow:hidden 会剪掉卡内手柄），
    // 且收起态没有可拖的东西。
    expect(wizardSrc).toMatch(/\{!assistCollapsed && \(\s*<div\s+data-pm-wizard-drag-handle/)
    expect(wizardSrc).toContain('onPointerCancel={assistDrag.onPointerUp}')
  })

  it('the anchor stays on the outermost node so the sibling assertion still holds', () => {
    // data-pm-form-assist must sit on the same element as the collapsed marker
    // (the shell), never on the inner card — probe §1 reads the shell's box.
    const outer = columnSrc.indexOf('data-form-assist-collapsed')
    expect(outer).toBeGreaterThan(-1)
    const tagStart = columnSrc.lastIndexOf('<div', outer)
    expect(columnSrc.slice(tagStart, columnSrc.indexOf('>', outer) + 1)).toContain('data-pm-form-assist')
    const rail = columnSrc.indexOf('data-form-assist-rail')
    expect(rail).toBeGreaterThan(outer)
  })

  it('collapse hides the card instead of unmounting it', () => {
    // The transcript/composer body is a value (`column`), rendered INSIDE the
    // card node — so hiding the card leaves the subtree mounted: composer
    // draft, transcript and scroll all survive the toggle.
    const body = columnSrc.indexOf('const column = (')
    expect(body).toBeGreaterThan(-1)
    expect(columnSrc.indexOf('<TranscriptView', body)).toBeGreaterThan(body)
    const card = columnSrc.indexOf('data-form-assist-card')
    expect(card).toBeGreaterThan(body)
    // Only a style flag, never a conditional around the children.
    expect(columnSrc.slice(card)).toContain('{column}')
    expect(columnSrc).toContain("...(isCollapsed ? { display: 'none' } : null)")
  })

  it('the toggle lives in the header, the way back lives in the rail', () => {
    const header = columnSrc.indexOf('const header = (')
    const column = columnSrc.indexOf('const column = (')
    const collapse = columnSrc.indexOf('data-form-assist-collapse')
    const expand = columnSrc.indexOf('data-form-assist-expand')
    expect(header).toBeGreaterThan(-1)
    expect(collapse).toBeGreaterThan(header)
    expect(collapse).toBeLessThan(column)
    expect(expand).toBeGreaterThan(column)
    // Shrink rightward / grow leftward, and the rail title reads top-to-bottom.
    expect(columnSrc).toContain("writingMode: 'vertical-rl'")
    expect(columnSrc).toContain('RightOutlined')
    expect(columnSrc).toContain('LeftOutlined')
  })

  it('the wizard owns the state and passes it down', () => {
    expect(wizardSrc).toContain('const [assistCollapsed, setAssistCollapsed] = useState(false)')
    expect(wizardSrc).toContain('collapsed={assistCollapsed}')
    expect(wizardSrc).toContain('onToggleCollapsed={() => setAssistCollapsed((v) => !v)}')
  })

  it('both locales carry the toggle labels', () => {
    const formAssistBlock = (src: string): string => {
      const at = src.indexOf('formAssist: {')
      return src.slice(at, src.indexOf('\n  },', at))
    }
    for (const src of [zhSrc, enSrc]) {
      const block = formAssistBlock(src)
      expect(block).toContain('collapse:')
      expect(block).toContain('expand:')
    }
  })
})
