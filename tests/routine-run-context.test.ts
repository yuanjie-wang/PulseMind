// ── Routine run-context tests (workspace / approval mode / model) ──
// The run context rides ONE chain, and every hop is load-bearing:
//   form draft → draftToRoutineInput → IPC normalizeInput (whitelist!) →
//   Routine fields → routine-runner → createSession options → session pin
//   → the conversation's own columns (seeded by the runner at creation —
//   user 2026-09-27: a continuation must carry the 授权/模型 the run ran
//   with; the pins alone die at settle/restart).
// The pure halves (draft roundtrip, validation) are driven directly; the
// runner is driven for real over mocked neighbours (session-manager
// transitively reaches AgentEngine and cannot load under plain Node); the
// renderer wiring is source-scanned because vitest here is node-env (no
// Electron) — the same recipe as tests/routine-params.test.ts.
//
// The session-manager pin is the half that is easy to "simplify" away: a
// profileId passed only to createSession (never pinned on the entry) is
// silently undone by the FIRST refreshOptions — a global model switch (or any
// settings save that sweeps sessions) moves a running routine back to the
// active model with nothing in the UI saying so.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_DRAFT, routineToDraft, draftToRoutineInput, applyAssistantPatch, validateDraft } from '../src/renderer/src/components/routine/routine-form-model'
import type { RoutineAssistantPatch } from '../src/renderer/src/components/routine/routine-assist'
import type { Routine } from '../src/shared/types/routine'
import type { AgentEventData } from '../src/shared/agent-protocol'

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
    // The pinned profile is hoisted so the SAME normalized value seeds the
    // conversation's profile_id column (the inheritance write below).
    expect(RUNNER).toContain('const pinnedProfileId = routine.profileId?.trim() || undefined')
    expect(RUNNER).toContain('profileId: pinnedProfileId,')
  })

  it('seeds the conversation columns with the run context, before the session exists', () => {
    // User 2026-09-27: continuing a run's conversation must carry what the
    // run ran with. The pins live only for the run's window; the columns are
    // what the transcript's composer reads and what a restart re-creates from.
    expect(RUNNER).toContain("setConversationApprovalMode(convId, routine.approvalMode ?? 'outside-ask')")
    expect(RUNNER).toContain('if (pinnedProfileId) setConversationProfile(convId, pinnedProfileId)')
    const seed = RUNNER.indexOf('setConversationApprovalMode(convId')
    const create = RUNNER.indexOf('await agentSessionManager.createSession(convId')
    expect(seed).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(seed)
    // Straight to the DB layer, not setApprovalMode/setSessionProfile — a
    // scheduled run must not rewrite the global last-used values.
    expect(RUNNER).not.toContain('rememberLastUsed')
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

// ── The runner, for real (mocked neighbours) ──
// session-manager transitively reaches AgentEngine and cannot load under
// plain Node, so the singleton is mocked; conversation.db would need
// better-sqlite3 (Electron-ABI). Everything between them — the run context
// seeding, the pin pass-through, the settlement release — is the real
// executeUnattended.

const {
  createSessionMock,
  askMock,
  releaseRunPinsMock,
  seedApprovalMock,
  seedProfileMock,
  sinks,
} = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  askMock: vi.fn(),
  releaseRunPinsMock: vi.fn(),
  seedApprovalMock: vi.fn(),
  seedProfileMock: vi.fn(),
  // The runner subscribes synchronously; tests settle a run by pushing a
  // status through the captured sink, the way the engine settles it.
  sinks: { current: null as null | ((sessionId: string, data: AgentEventData) => void) },
}))

vi.mock('../src/main/agent/session-manager', () => ({
  agentSessionManager: {
    createSession: createSessionMock,
    ask: askMock,
    releaseRunPins: releaseRunPinsMock,
    engineCall: vi.fn(),
    history: vi.fn(async () => ({ messages: [] })),
    onEvent: (sink: (sessionId: string, data: AgentEventData) => void) => {
      sinks.current = sink
      return () => { sinks.current = null }
    },
  },
}))
vi.mock('../src/main/storage/conversation.db', () => ({
  saveConversation: vi.fn(),
  setConversationApprovalMode: seedApprovalMock,
  setConversationProfile: seedProfileMock,
}))
vi.mock('../src/main/storage/routine-store', () => ({
  routineStore: { finishRun: vi.fn(), startRun: vi.fn() },
}))
vi.mock('../src/main/storage/audit-store', () => ({
  auditStore: { record: vi.fn() },
}))
vi.mock('../src/main/storage/conversation-workspace', () => ({
  resolveConversationWorkspace: vi.fn(async () => '/tmp/run-context-ws'),
}))

import { executeUnattended } from '../src/main/routine/routine-runner'

describe('the runner seeds the run context (driven for real)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createSessionMock.mockResolvedValue({ sessionId: 'routine_x', agentId: 'default' })
    askMock.mockResolvedValue(undefined)
  })

  const fire = (routine: Partial<Routine>): void => {
    executeUnattended({
      runId: 'run1',
      routine: {
        id: 'rtn_x',
        name: '测试任务',
        description: '',
        prompt: '检查 {{name}}',
        enabled: true,
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
        ...routine,
      },
      convId: 'routine_x',
      params: { name: 'demo' },
      notifyOnFinish: false,
    })
  }

  const settle = (): void => {
    sinks.current?.('routine_x', { type: 'status', status: 'completed' } as AgentEventData)
  }

  it('records the configured 授权 level and pinned model into the columns, before the session is created', async () => {
    fire({ approvalMode: 'auto', profileId: 'prof_a' })
    await vi.waitFor(() => expect(askMock).toHaveBeenCalled())

    expect(seedApprovalMock).toHaveBeenCalledWith('routine_x', 'auto')
    expect(seedProfileMock).toHaveBeenCalledWith('routine_x', 'prof_a')
    expect(createSessionMock).toHaveBeenCalledWith('routine_x', expect.objectContaining({
      clientId: 'routine',
      approvalMode: 'auto',
      profileId: 'prof_a',
    }))
    // Order is the contract: a restart re-creates the session from the column
    // ALONE, and doCreateSession resolves the model from opts ?? column — a
    // write landing after the create would race it and lose.
    expect(seedApprovalMock.mock.invocationCallOrder[0])
      .toBeLessThan(createSessionMock.mock.invocationCallOrder[0])
    expect(seedProfileMock.mock.invocationCallOrder[0])
      .toBeLessThan(createSessionMock.mock.invocationCallOrder[0])
  })

  it('a routine with no configured level still seeds the unattended literal — never DEFAULT_APPROVAL_MODE', async () => {
    fire({})
    await vi.waitFor(() => expect(askMock).toHaveBeenCalled())
    // The literal, not the shared constant: a UI default move must not
    // retroactively change what an unattended conversation continues at.
    expect(seedApprovalMock).toHaveBeenCalledWith('routine_x', 'outside-ask')
  })

  it('a routine with no pinned model leaves profile_id alone — the active profile at run time is not this conversation\'s choice', async () => {
    fire({})
    await vi.waitFor(() => expect(askMock).toHaveBeenCalled())

    expect(seedProfileMock).not.toHaveBeenCalled()
    expect(createSessionMock).toHaveBeenCalledWith('routine_x', expect.objectContaining({ profileId: undefined }))
  })

  it('settlement releases BOTH pins, so the user\'s own pick is not pinned over until restart', async () => {
    fire({ approvalMode: 'always-ask', profileId: 'prof_b' })
    await vi.waitFor(() => expect(askMock).toHaveBeenCalled())
    expect(releaseRunPinsMock).not.toHaveBeenCalled()

    settle()
    expect(releaseRunPinsMock).toHaveBeenCalledWith('routine_x')
  })
})

describe('wiring: the run transcript inherits via the columns', () => {
  const WORKSPACE = read('src', 'renderer', 'src', 'components', 'routine', 'RoutineWorkspace.tsx')

  it('the composer shows the conversation\'s own model, default last', () => {
    // Display: the row's column first, the global default only for a
    // conversation that never chose — the chat's own fallback shape.
    expect(WORKSPACE).toContain('activeProfileId={convProfileId ?? settings.activeProfileId}')
    expect(WORKSPACE).toContain('getConversation(convId)')
  })

  it('a model pick writes the conversation column, not the global default', () => {
    expect(WORKSPACE).toContain('window.electronAPI.setConversationProfile(convId, profileId)')
    // The old surface moved the GLOBAL default on every pick; no call site
    // may remain (the header comment's mention of the name is the point).
    expect(WORKSPACE).not.toContain('switchProfile(')
  })
})
