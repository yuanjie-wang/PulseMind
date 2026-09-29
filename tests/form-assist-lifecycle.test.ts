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
  return { calls, failDispose: () => { disposeFails = true } }
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
  const routineSrc = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineEditorPage.tsx')

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
    expect(expertSrc).toContain("discardBoundSession(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, null))")
    // Mounting straight into create mode is a create entry too.
    expect(expertSrc).toContain('mountedCreateRef')
    // Deleting an expert disposes the live session before the row goes.
    expect(expertSrc).toContain('await discardAssistConversation(formAssistConversationId(EXPERT_ASSIST_SPEC.conversationPrefix, profile.id))')
  })

  it('RoutineEditorPage wires the same four points', () => {
    expect(routineSrc).toContain('onNewSession={discardBoundSession}')
    expect(routineSrc).toMatch(/await promoteAssistDraftToEntity\(/)
    expect(routineSrc).toMatch(/promoteAssistDraftToEntity\(\s*assist\.messages,\s*ROUTINE_ASSIST_SPEC\.conversationPrefix,/)
    const promote = routineSrc.indexOf('promoteAssistDraftToEntity(')
    const rebind = routineSrc.indexOf('setBoundId(created.id)')
    expect(promote).toBeGreaterThan(-1)
    expect(rebind).toBeGreaterThan(promote)
    // The page is not remounted per switch — the boundId → null transition is
    // the create-entry trigger (startNew / 模板预填 / 提取 / 失效回退 all land there).
    expect(routineSrc).toMatch(/if \(boundId !== null\) return[\s\S]*?discardBoundSession\(\)/)
    expect(routineSrc).toContain('await discardAssistConversation(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, routine.id))')
  })

  it('deletion cleanup no longer deletes rows without disposing the session', () => {
    // Non-vacuity: the raw deleteConversation call is exactly the shape that
    // leaves a stale engine holding the discarded thread's context.
    expect(expertSrc).not.toMatch(/deleteConversation\(formAssist/)
    expect(routineSrc).not.toMatch(/deleteConversation\(formAssist/)
  })
})
