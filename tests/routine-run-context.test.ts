// ── Routine run-context tests (workspace / approval mode / model) ──
// The run context rides ONE chain, and every hop is load-bearing:
//   form draft → draftToRoutineInput → IPC normalizeInput (whitelist!) →
//   Routine fields → routine-runner → createSession options → session pin.
// The pure halves (draft roundtrip, validation) are driven directly; the main
// process wiring is source-scanned because vitest here is node-env (no
// Electron) — the same recipe as tests/routine-params.test.ts.
//
// The session-manager pin is the half that is easy to "simplify" away: a
// profileId passed only to createSession (never pinned on the entry) is
// silently undone by the FIRST refreshOptions — a global model switch (or any
// settings save that sweeps sessions) moves a running routine back to the
// active model with nothing in the UI saying so.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_DRAFT, routineToDraft, draftToRoutineInput, applyAssistantPatch, validateDraft } from '../src/renderer/src/components/routine/routine-form-model'
import type { RoutineAssistantPatch } from '../src/renderer/src/components/routine/routine-assist'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

const CONTEXT_ROUTINE: Routine = {
  id: 'r_ctx',
  name: '巡检',
  description: '',
  prompt: '检查',
  enabled: true,
  workspaceDir: '/tmp/pulse-runs',
  approvalMode: 'auto',
  profileId: 'prof_a',
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
}

describe('run context: the draft roundtrip', () => {
  it('carries the three fields from a stored routine into the save payload', () => {
    const input = draftToRoutineInput(routineToDraft(CONTEXT_ROUTINE))
    expect(input.workspaceDir).toBe('/tmp/pulse-runs')
    expect(input.approvalMode).toBe('auto')
    expect(input.profileId).toBe('prof_a')
  })

  it('defaults to conversation behavior — a fresh draft carries none of them', () => {
    expect(EMPTY_DRAFT.workspaceDir).toBeUndefined()
    expect(EMPTY_DRAFT.approvalMode).toBeUndefined()
    expect(EMPTY_DRAFT.profileId).toBeUndefined()
    const input = draftToRoutineInput({ ...EMPTY_DRAFT, name: 'x', prompt: 'y' })
    expect(input.workspaceDir).toBeUndefined()
    expect(input.approvalMode).toBeUndefined()
    expect(input.profileId).toBeUndefined()
  })

  it('normalizes blank run-context values to undefined, not empty strings', () => {
    const draft = routineToDraft(CONTEXT_ROUTINE)
    draft.workspaceDir = '   '
    draft.profileId = ''
    const input = draftToRoutineInput(draft)
    // An empty-string workspaceDir would ride createSession as a falsy-but-
    // present value and read as "explicitly the empty path"; the payload must
    // say "absent" so the runner mints the session folder.
    expect(input.workspaceDir).toBeUndefined()
    expect(input.profileId).toBeUndefined()
  })
})

describe('run context: the assistant never blanks it', () => {
  it('keeps the three fields through an assistant patch that does not carry them', () => {
    const draft = routineToDraft(CONTEXT_ROUTINE)
    const patch: RoutineAssistantPatch = { name: '新名字', prompt: '新提示词 {{repo}}' }
    const next = applyAssistantPatch(patch, draft)
    expect(next.workspaceDir).toBe('/tmp/pulse-runs')
    expect(next.approvalMode).toBe('auto')
    expect(next.profileId).toBe('prof_a')
    expect(next.name).toBe('新名字')
  })
})

describe('run context: validation', () => {
  it('rejects a workspace path that is not absolute', () => {
    const draft = { ...EMPTY_DRAFT, workspaceDir: 'relative/path' }
    expect(validateDraft(draft)).toContain('绝对路径')
  })

  it('rejects the ~ shorthand the main process never expands', () => {
    const draft = { ...EMPTY_DRAFT, workspaceDir: '~/runs' }
    expect(validateDraft(draft)).toContain('~')
  })

  it('accepts an absolute path and stays silent about an empty one', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, workspaceDir: '/tmp/pulse-runs' })).toBeNull()
    expect(validateDraft({ ...EMPTY_DRAFT, workspaceDir: '  ' })).toBeNull()
    expect(validateDraft(EMPTY_DRAFT)).toBeNull()
  })
})

// ── Wiring (source scans) ──

describe('wiring: the IPC whitelist carries the run context', () => {
  const HANDLER = read('src', 'main', 'ipc', 'routine.handler.ts')

  it('normalizeInput forwards all three fields', () => {
    expect(HANDLER).toContain('workspaceDir: input.workspaceDir?.trim() || undefined')
    expect(HANDLER).toContain('approvalMode: input.approvalMode')
    expect(HANDLER).toContain('profileId: input.profileId?.trim() || undefined')
  })

  it('validates on BOTH create and update, at the one door every save passes', () => {
    expect(HANDLER).toContain('assertRunContext(input)')
    expect(HANDLER).toContain('assertRunContext(patch)')
    // The approval whitelist is closed — a garbage mode would silently change
    // what the unattended gates allow.
    expect(HANDLER).toContain("'auto', 'outside-ask', 'always-ask'")
    expect(HANDLER).toContain('checkWorkspacePathFormat')
  })
})

describe('wiring: the runner applies the run context', () => {
  const RUNNER = read('src', 'main', 'routine', 'routine-runner.ts')

  it('resolves the workspace itself (clientId routine never reaches the session manager resolution)', () => {
    expect(RUNNER).toContain("from '../storage/conversation-workspace'")
    expect(RUNNER).toContain('resolveConversationWorkspace(convId)')
  })

  it('passes workspace / approval / profile into createSession', () => {
    expect(RUNNER).toContain('workspaceDir,')
    expect(RUNNER).toContain("approvalMode: routine.approvalMode ?? 'outside-ask'")
    expect(RUNNER).toContain('profileId: routine.profileId?.trim() || undefined')
  })

  it('hands the resolved workspace to the prompt renderer for {{workspace}}', () => {
    // Batch rows ride the same call site: opts.row feeds {{row}} (absent for
    // single runs, so the token stays visible there).
    expect(RUNNER).toContain('renderRoutinePrompt(routine, opts.params, { workspaceDir, row: opts.row })')
  })
})

describe('wiring: the model pin survives refreshOptions', () => {
  const MANAGER = read('src', 'main', 'agent', 'session-manager.ts')

  it('resolveProfile prefers an explicit id before the active one', () => {
    expect(MANAGER).toContain('resolveProfile(preferredId?: string)')
    expect(MANAGER).toContain("settings.profiles.find((p) => p.id === preferredId)")
  })

  it('pins the requested profileId on the session entry', () => {
    expect(MANAGER).toContain('profileId: opts.profileId,')
    // Create-time resolution honours the pin first, then the conversation's
    // own stored model, then the global default inside resolveProfile.
    expect(MANAGER).toContain('const profile = await this.resolveProfile(opts.profileId ?? getConversationProfileId(sessionId))')
  })

  it('refreshOptions re-resolves through the pin, not the global active profile', () => {
    // effectiveProfileId is the one precedence place (mirrors
    // effectiveApprovalMode): the create-time pin > the conversation's stored
    // model > undefined (the global default). This line is what makes
    // setActiveProfile's global sweep a no-op for pinned sessions.
    expect(MANAGER).toContain('private effectiveProfileId(sessionId: string, entry: SessionEntry): string | undefined')
    expect(MANAGER).toContain('return entry.pinned.profileId ?? getConversationProfileId(sessionId)')
    expect(MANAGER).toContain('const profile = await this.resolveProfile(this.effectiveProfileId(sessionId, entry))')
  })

  it('the create options carry the field at all', () => {
    expect(read('src', 'shared', 'agent-protocol', 'payloads.ts')).toContain('profileId?: string')
  })
})

describe('wiring: the form exposes the run context', () => {
  const FORM = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineForm.tsx')

  it('renders the three pickers and the directory dialog', () => {
    expect(FORM).toContain('工作区')
    expect(FORM).toContain('授权方式')
    expect(FORM).toContain('模型')
    expect(FORM).toContain("properties: ['openDirectory']")
  })

  it('renders the insert-variable control fed by the built-ins', () => {
    expect(FORM).toContain('插入变量')
    expect(FORM).toContain('BUILTIN_VAR_OPTIONS')
  })
})

describe('wiring: the draft model keeps the fields', () => {
  it('routineToDraft and draftToRoutineInput name all three', () => {
    const MODEL = read('src', 'renderer', 'src', 'components', 'routine', 'routine-form-model.ts')
    expect(MODEL).toContain('workspaceDir: routine.workspaceDir')
    expect(MODEL).toContain('approvalMode: routine.approvalMode')
    expect(MODEL).toContain('profileId: routine.profileId')
    expect(MODEL).toContain('workspaceDir: draft.workspaceDir?.trim() || undefined')
  })
})
