// ── The 授权 button across the hosted-session surfaces ──
// Four composers draw the chat's own 授权 button over a hosted session: the
// form-assist columns (routine/expert editors), the routine run transcript and
// the tool studio. All four share one state hook (useConversationApprovalMode —
// read the conversation row, optimistic move, then the main chat's exact two
// steps: column write BEFORE the engine refresh). The studio additionally
// seeds 全部允许 into the column because its old create-time PIN outranked the
// column forever (session-manager.effectiveApprovalMode), which would have made
// the button's click a no-op; the routine runner now releases its unattended
// pin when the run settles, so post-run continuations follow the column.
//
// Source assertions, because vitest here is node-env with no jsdom and no
// @testing-library: the hooks cannot be mounted, so what a unit test could
// see is only the wiring. Same reasoning as tests/pending-approval.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { conversationKeyOf } from '../src/shared/conversation-key'

const REPO = process.cwd()
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf-8')

const SHARED_HOOK = read('src', 'renderer', 'src', 'hooks', 'useConversationApprovalMode.ts')
const HOSTED = read('src', 'renderer', 'src', 'hooks', 'useHostedAgentSession.ts')
const FORM_HOOK = read('src', 'renderer', 'src', 'components', 'form-assist', 'useFormAssistSession.ts')
const FORM_COLUMN = read('src', 'renderer', 'src', 'components', 'form-assist', 'FormAssistColumn.tsx')
const ROUTINE_WS = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineWorkspace.tsx')
const TOOL_WS = read('src', 'renderer', 'src', 'components', 'tool-studio', 'ToolWorkspace.tsx')
const STUDIO = read('src', 'renderer', 'src', 'tool-studio', 'useStudioSession.ts')
const CONV_DB = read('src', 'main', 'storage', 'conversation.db.ts')
const SESSION_MGR = read('src', 'main', 'agent', 'session-manager.ts')
const RUNNER = read('src', 'main', 'routine', 'routine-runner.ts')

describe('useConversationApprovalMode (the shared state)', () => {
  it('reads the level off the conversation row when the surface activates', () => {
    expect(SHARED_HOOK).toContain('.getConversation(id)')
    expect(SHARED_HOOK).toContain("setState({ convId, mode: conv?.approvalMode })")
    // The state carries its convId and the read is derived: switching entities
    // (same mount, new convId) must not show the previous thread's level while
    // the next fetch is in flight — a mismatch reads as "never chosen", the
    // same fallback the engine's own resolver follows.
    expect(SHARED_HOOK).toContain('state.convId === convId ? state.mode : undefined')
  })

  it('reads the key through conversationKeyOf, never a typeof test', () => {
    expect(SHARED_HOOK).toContain('conversationKeyOf(convId)')
    // The empty string is "nothing open", not an id (see
    // tests/conversation-key.test.ts) — a typeof guard would write to ''.
    expect(SHARED_HOOK).not.toMatch(/typeof\s+\w*[Cc]onv[Ii]d\w*\s*===?\s*'string'/)
  })

  it('writes the column before refreshing the engine', () => {
    const write = SHARED_HOOK.indexOf('await window.electronAPI.setConversationApprovalMode(id, mode)')
    const refresh = SHARED_HOOK.indexOf('await window.electronAPI.agentSessionRefreshOptions(id)', write)
    expect(write).toBeGreaterThan(-1)
    expect(refresh).toBeGreaterThan(write)
    // Inside the same async body: the await between them is the invariant.
    expect(SHARED_HOOK.slice(write, refresh)).toContain('await')
  })

  it('is optimistic — the button moves before the IPC round trip lands', () => {
    const optimistic = SHARED_HOOK.indexOf('setState({ convId, mode })')
    const write = SHARED_HOOK.indexOf('await window.electronAPI.setConversationApprovalMode(id, mode)')
    expect(optimistic).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(optimistic)
  })
})

describe('the four composers draw the button from their session', () => {
  it('the hosted session (form-assist, run transcript) exposes the shared state', () => {
    // The second arg is the 新会话 resetKey: a discarded thread re-reads the
    // (deleted) row instead of keeping the old level on the fresh one.
    expect(HOSTED).toContain('useConversationApprovalMode(convId, resetKey)')
    expect(HOSTED).toContain('approvalMode: approval.approvalMode')
    expect(HOSTED).toContain('setApprovalMode: approval.setApprovalMode')
    // Non-vacuity: the interface this test talks about is really there.
    expect(HOSTED).toContain('approvalMode: SandboxApprovalMode | undefined')
  })

  it('the form-assist column delegates and turns the button on', () => {
    expect(FORM_HOOK).toContain('approvalMode: session.approvalMode')
    expect(FORM_HOOK).toContain('setApprovalMode: session.setApprovalMode')
    expect(FORM_COLUMN).toContain('authorization: true')
    expect(FORM_COLUMN).toContain('approvalMode={session.approvalMode}')
    expect(FORM_COLUMN).toContain('onChangeApprovalMode={session.setApprovalMode}')
  })

  it('the routine run transcript wires the button to the hosted session', () => {
    expect(ROUTINE_WS).toContain('features={{ modelPicker: true, authorization: true }}')
    expect(ROUTINE_WS).toContain('approvalMode={session.approvalMode}')
    expect(ROUTINE_WS).toContain('onChangeApprovalMode={session.setApprovalMode}')
  })

  it('the tool studio wires the button to the studio session', () => {
    expect(STUDIO).toContain('useConversationApprovalMode(convId)')
    expect(TOOL_WS).toContain('features={{ modelPicker: true, authorization: true }}')
    expect(TOOL_WS).toContain('approvalMode={session.approvalMode}')
    expect(TOOL_WS).toContain('onChangeApprovalMode={session.setApprovalMode}')
  })
})

describe('the tool studio: column seed instead of a create-time pin', () => {
  it('no longer pins approvalMode at create', () => {
    const create = STUDIO.indexOf('agentSessionCreate(convId,')
    expect(create).toBeGreaterThan(-1)
    const opts = STUDIO.slice(create, STUDIO.indexOf('})', create))
    // A creation-time pin outranks the column forever — with one, the button
    // could never win.
    expect(opts).not.toContain('approvalMode')
  })

  it('seeds 全部允许 into the column, once, before the session exists', () => {
    // source 'derived': the seed is the studio's historical default, not the
    // user's choice — it must not update the sticky last-used value.
    const seed = STUDIO.indexOf("setConversationApprovalMode(convId, 'auto', 'derived')")
    const create = STUDIO.indexOf('agentSessionCreate(convId,')
    expect(seed).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(seed)
    // Only while unset (row missing or column null) — an unconditional write
    // would clobber the user's pick on every remount, and the button would
    // never hold anything.
    expect(STUDIO).toContain('stored?.approvalMode === undefined')
  })
})

describe('main-side support', () => {
  it("getConversation actually ships the column the hooks read", () => {
    const from = CONV_DB.indexOf('export function getConversation(id: string)')
    expect(from).toBeGreaterThan(-1)
    const body = CONV_DB.slice(from, CONV_DB.indexOf('export function saveConversation'))
    expect(body).toContain('approval_mode')
    expect(body).toContain('approvalMode: toSandboxApprovalMode(conv.approval_mode)')
  })

  it('every stub-insert derives the conversation type from the id', () => {
    // The binding setters stub-insert rows for threads nothing was ever sent
    // to (routine_assist_*, toolstudio_*, …). A hardcoded 'normal' type would
    // leak them into the sidebar until the first transcript save corrected it.
    // The INSERT lives once in the shared stubInsertConversation helper —
    // named bindings, after its positional predecessor bound the project id
    // into `type` (2026-09-17) — and derives the type there; a setter may
    // only name its own binding column.
    const helperFrom = CONV_DB.indexOf('function stubInsertConversation(id: string')
    expect(helperFrom).toBeGreaterThan(-1)
    const helper = CONV_DB.slice(helperFrom, CONV_DB.indexOf('export function ', helperFrom))
    expect(helper).toContain('INSERT INTO conversations')
    expect(helper).toContain('type: deriveConvType(id)')
    expect(helper).not.toContain("'normal'")
    const bindingColumns: Record<string, string> = {
      setConversationProject: 'project_id',
      setConversationExpert: 'expert_id',
      setConversationApprovalMode: 'approval_mode',
      setConversationWorkspaceDir: 'workspace_dir'
    }
    for (const [setter, column] of Object.entries(bindingColumns)) {
      const from = CONV_DB.indexOf(`export function ${setter}(id: string`)
      expect(from, setter).toBeGreaterThan(-1)
      // Stop at the next declaration or doc comment: a trailing neighbour's
      // comment may quote `'normal'` (the repair's does) without any setter
      // writing it.
      const nextDecl = CONV_DB.slice(from + 1).search(/\n(export function |\/\*\*)/)
      const body = nextDecl === -1 ? CONV_DB.slice(from) : CONV_DB.slice(from, from + 1 + nextDecl)
      expect(body, setter).toContain(`stubInsertConversation(id, { ${column}:`)
      expect(body, setter).not.toContain("'normal'")
    }
  })

  it('releaseApprovalPin clears the override and re-resolves the engine', () => {
    expect(SESSION_MGR).toContain('releaseApprovalPin(sessionId: string): void')
    const from = SESSION_MGR.indexOf('releaseApprovalPin(sessionId: string): void')
    const body = SESSION_MGR.slice(from, from + 700)
    expect(body).toContain('entry.pinned.approvalOverride = undefined')
    expect(body).toContain('this.effectiveApprovalMode(sessionId, entry)')
  })

  it('the routine runner releases the pin when the run settles', () => {
    // Non-vacuity: the runner really pins its unattended runs. The level is
    // user-selectable per routine now (2026-09-21), but a routine that never
    // chose one must still pin the unattended default — as a literal, never
    // DEFAULT_APPROVAL_MODE, so a UI default move cannot widen a watched run.
    // (The finish shape is the batch-shared primitive's: 'success' | 'failed',
    // with releaseApprovalPin inside, ahead of the transcript announce.)
    expect(RUNNER).toContain("approvalMode: routine.approvalMode ?? 'outside-ask'")
    const finish = RUNNER.indexOf("const finish = (status: 'success' | 'failed', error?: string): void =>")
    expect(finish).toBeGreaterThan(-1)
    const release = RUNNER.indexOf('agentSessionManager.releaseApprovalPin(convId)', finish)
    expect(release).toBeGreaterThan(finish)
    // Inside finish's body, before the transcript persist announces the run.
    const persist = RUNNER.indexOf('void persistTranscript(convId, opts.transcriptLabel', finish)
    expect(persist).toBeGreaterThan(release)
  })
})

describe('conversationKeyOf (hosted-approval contract)', () => {
  it('lets a real session id through', () => {
    expect(conversationKeyOf('routine_assist_draft')).toBe('routine_assist_draft')
    expect(conversationKeyOf('toolstudio_tool123')).toBe('toolstudio_tool123')
    expect(conversationKeyOf('routine_1726480000000_abc123')).toBe('routine_1726480000000_abc123')
  })

  it('keeps "nothing open" out of the write path', () => {
    expect(conversationKeyOf('')).toBeUndefined()
    expect(conversationKeyOf('   ')).toBeUndefined()
    expect(conversationKeyOf(undefined)).toBeUndefined()
    expect(conversationKeyOf(null)).toBeUndefined()
  })
})
