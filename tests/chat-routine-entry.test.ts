// ── 存为日常任务: the chat toolbar's routine entry ──
// Two layers, because neither covers the other (the pending-approval pattern):
// the gating rules and the transcript flattener are pure and run for real here,
// while "button → ChatView gating → controller → editor draft" is wiring that
// node-env vitest cannot mount (no jsdom) — pinned as source scans, each with
// its ordering or scope made explicit.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  routineEntryAllowed,
  routineEntryTargetIndex,
} from '../src/renderer/src/components/chat/routine-entry'
import { conversationToRoutineText } from '../src/renderer/src/components/routine/routine-extract'
import type { Segment } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage } from '../src/renderer/src/types/agent'

const msg = (id: string, role: 'user' | 'assistant', text?: string): AgentMessage =>
  ({
    id,
    role,
    createdAt: '2026-09-21T10:00:00.000Z',
    contentBlocks: text === undefined ? [] : [{ type: 'text', text }],
  }) as AgentMessage

const single = (m: AgentMessage): Segment => ({ type: 'single', msg: m })
const execution = (ms: AgentMessage[]): Segment => ({ type: 'execution', msgs: ms })
const streaming: Segment = { type: 'streaming', blocks: [{ type: 'text', text: '…' }] }

describe('routineEntryTargetIndex (where the 存为日常任务 button rides)', () => {
  it('rides the tail when the conversation closes on assistant text', () => {
    const segments = [single(msg('u1', 'user', '每天帮我整理周报')), single(msg('a1', 'assistant', '好的'))]
    expect(routineEntryTargetIndex(segments)).toBe(1)
  })

  it('offers nothing on a user tail — there is no action row to ride', () => {
    const segments = [single(msg('a1', 'assistant', '好的')), single(msg('u2', 'user', '再见'))]
    expect(routineEntryTargetIndex(segments)).toBeNull()
  })

  it('offers nothing while the tail is an execution segment (no row renders)', () => {
    const segments = [single(msg('u1', 'user', '跑')), execution([msg('a1', 'assistant')])]
    expect(routineEntryTargetIndex(segments)).toBeNull()
  })

  it('offers nothing while the tail is streaming text', () => {
    expect(routineEntryTargetIndex([single(msg('u1', 'user', 'hi')), streaming])).toBeNull()
  })

  it('offers nothing on an empty transcript', () => {
    expect(routineEntryTargetIndex([])).toBeNull()
  })
})

describe('routineEntryAllowed (a settled turn is the fair thing to distill)', () => {
  it('allows the terminal statuses: idle, completed, error', () => {
    expect(routineEntryAllowed('idle')).toBe(true)
    expect(routineEntryAllowed('completed')).toBe(true)
    expect(routineEntryAllowed('error')).toBe(true)
  })

  it('refuses a turn in motion or a decision in waiting', () => {
    for (const status of ['streaming', 'executing', 'retrying', 'awaiting_approval', 'awaiting_user_input', 'awaiting_extension', 'awaiting_continue'] as const) {
      expect(routineEntryAllowed(status)).toBe(false)
    }
  })
})

describe('conversationToRoutineText (the transcript the agent reads)', () => {
  it('labels turns 用户/助手 and joins them with blank lines', () => {
    const text = conversationToRoutineText([
      { role: 'user', contentBlocks: [{ type: 'text', text: '每周五整理周报' }] },
      { role: 'assistant', contentBlocks: [{ type: 'text', text: '好的，规则是…' }] },
    ])
    expect(text).toBe('用户：每周五整理周报\n\n助手：好的，规则是…')
  })

  it('keeps only text blocks and drops silent messages entirely', () => {
    const text = conversationToRoutineText([
      { role: 'assistant', contentBlocks: [{ type: 'tool_use', id: 't1' }] },
      { role: 'user', contentBlocks: [{ type: 'text', text: '第一条' }, { type: 'text', text: '第二条' }] },
    ])
    expect(text).toBe('用户：第一条\n第二条')
  })

  it('is empty for a conversation with nothing to say', () => {
    expect(conversationToRoutineText(undefined)).toBe('')
    expect(conversationToRoutineText([{ role: 'assistant', contentBlocks: [{ type: 'tool_result', content: 'x' }] }])).toBe('')
  })
})

const REPO = process.cwd()
const CHAT_VIEW = join(REPO, 'src', 'renderer', 'src', 'components', 'layout', 'ChatView.tsx')
const CONTROLLER = join(REPO, 'src', 'renderer', 'src', 'hooks', 'useChatController.ts')
const APP = join(REPO, 'src', 'renderer', 'src', 'App.tsx')
const EDITOR = join(REPO, 'src', 'renderer', 'src', 'components', 'routine', 'TaskWizardPage.tsx')
const VIEW_HOST = join(REPO, 'src', 'renderer', 'src', 'components', 'layout', 'ViewHost.tsx')
const FORM_MODEL = join(REPO, 'src', 'renderer', 'src', 'components', 'routine', 'routine-form-model.ts')

describe('存为日常任务 wiring (button → gating → controller → editor)', () => {
  const chatViewSrc = readFileSync(CHAT_VIEW, 'utf-8')
  const controllerSrc = readFileSync(CONTROLLER, 'utf-8')
  const appSrc = readFileSync(APP, 'utf-8')
  const editorSrc = readFileSync(EDITOR, 'utf-8')
  const viewHostSrc = readFileSync(VIEW_HOST, 'utf-8')
  const formModelSrc = readFileSync(FORM_MODEL, 'utf-8')

  it('the button exists only where the callback arrives (MessageGroup)', () => {
    const groupSrc = readFileSync(join(REPO, 'src', 'renderer', 'src', 'components', 'chat', 'MessageGroup.tsx'), 'utf-8')
    // The prop is optional: hosts without the entry (sub-agent preview, the
    // extension panel's mirror) render the row without the button.
    expect(groupSrc).toContain('onExtractRoutine?: () => void | Promise<void>')
    expect(groupSrc).toContain('data-testid="routine-extract"')
    // The entry rides the full-variant row only — viewOnly/none hosts never see it.
    const from = groupSrc.indexOf("{actions === 'full' && (")
    expect(from).toBeGreaterThan(-1)
    expect(groupSrc.indexOf('routine-extract')).toBeGreaterThan(from)
    // One click, one extraction: the latch keeps the await inert.
    expect(groupSrc).toContain('if (!onExtractRoutine || extractingRoutine) return')
  })

  it('ChatView gates the entry to the last settled segment', () => {
    expect(chatViewSrc).toContain('routineEntryAllowed(agentStatus.status)')
    expect(chatViewSrc).toContain('routineEntryTargetIndex(allSegments)')
    // The prop lands on exactly the one index the gating named — every other
    // segment renders without it.
    expect(chatViewSrc).toContain('routineEntryIndex === index ? onExtractRoutine : undefined')
  })

  it('the controller runs the shared chain, then navigates with the draft', () => {
    expect(controllerSrc).toContain('extractRoutineFromConversation(')
    // Navigation carries the draft; the editor creates nothing until saved.
    const extract = controllerSrc.indexOf('extractRoutineFromConversation(')
    const navigate = controllerSrc.indexOf("navigate({ kind: 'routines', routineEditing: true, routineDraft: draft })")
    expect(navigate).toBeGreaterThan(extract)
  })

  it('App threads the controller callback into ChatView', () => {
    expect(appSrc).toContain('onExtractRoutine={extractRoutine}')
  })

  it('the editor consumes the draft on mount through the shared apply path', () => {
    // The one-shot consumption guard (same shape as the template prefill).
    expect(editorSrc).toContain('chatDraftAppliedRef.current = true')
    expect(editorSrc).toContain('applyExtractedDraft(routineDraft)')
    // Both entries (picker and chat toolbar) fill the form through ONE path.
    const applyDef = editorSrc.indexOf('const applyExtractedDraft = useCallback')
    expect(applyDef).toBeGreaterThan(-1)
    expect(editorSrc.indexOf('applyExtractedDraft(result)')).toBeGreaterThan(applyDef)
    // Ignored while editing an existing routine — a draft never overwrites one.
    const effectFrom = editorSrc.indexOf('chatDraftAppliedRef')
    expect(editorSrc.slice(effectFrom)).toContain('if (kind !== \'routine\' || routineId || chatDraftAppliedRef.current) return')
  })

  it('ViewHost hands the navigation param to the editor', () => {
    expect(viewHostSrc).toContain('routineDraft={view.routineDraft}')
  })

  it('a created routine keeps the conversation link', () => {
    // The whole point of the handoff: 存为日常任务 on a conversation stays
    // traceable to that conversation (Routine.sourceConversationId).
    expect(formModelSrc).toContain('sourceConversationId: draft.sourceConversationId')
  })
})
