// Renderer-terminal gate (review 2026-09-25 P0-3): the engine's own terminal
// calls run main-side under the approval ladder, but EVERYTHING arriving on
// the `terminal:*` invoke channels is renderer code — an XSS hitting an
// ungated IPC was unattended RCE. The gate now demands a NATIVE confirmation
// dialog (a window page content cannot script) plus the mechanical workspace
// cwd jail when a sessionId is supplied, and audits either way. This test
// drives the REAL registered handlers from the production `registerTerminalHandlers`
// (via the electron stub's ipcMain registry), with the service layer mocked so
// nothing actually spawns.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dialog,
  getStubDialogCalls,
  ipcMain,
  resetStubDialog,
  setStubDialogResponse,
} from './stubs/electron'

interface AuditRow {
  actor: string | null
  action: string
  target: string | null
  decision: string
  meta: string | null
}

const { auditRows, workspace, svc } = vi.hoisted(() => ({
  auditRows: [] as AuditRow[],
  // Mutable box: getConversationWorkspaceDir reads it at call time.
  workspace: { dir: null as string | null },
  svc: {
    execute: vi.fn(() => Promise.resolve({ processId: 'p_test' })),
    sync: vi.fn(() => Promise.resolve({ output: 'ok', code: 0 })),
    kill: vi.fn(),
  },
}))

vi.mock('../src/main/services/terminal', () => ({
  svcExecuteCommand: svc.execute,
  svcExecSync: svc.sync,
  svcKillCommand: svc.kill,
}))

vi.mock('../src/main/storage/conversation.db', () => ({
  getConversationWorkspaceDir: (id: string): string | null =>
    id === 'conv_ws' ? workspace.dir : null,
}))

// Same capture shape as the copy-file test: the INSERT's column order is
// id, ts, scope, actor, action, target, decision, policy_json, meta_json.
vi.mock('../src/main/storage/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO audit_log')) {
          auditRows.push({
            actor: (args[3] as string | null) ?? null,
            action: String(args[4]),
            target: (args[5] as string | null) ?? null,
            decision: String(args[6]),
            meta: (args[8] as string | null) ?? null,
          })
        }
      },
      all: () => [],
    }),
  }),
  initializeDatabase: async () => {},
  ensureDbHealthy: async () => {},
}))

import { registerTerminalHandlers } from '../src/main/ipc/terminal.handler'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

type Handler = (...args: unknown[]) => Promise<unknown>

function handler(channel: string): Handler {
  const h = ipcMain.handlers.get(channel)
  if (!h) throw new Error(`no handler registered for ${channel}`)
  return h as Handler
}

/** Synthetic invoke event: a fake webContents that records every send. */
function fakeEvent(destroyed = false): {
  event: { sender: { isDestroyed: () => boolean; send: (c: string, p: unknown) => void } }
  sent: Array<{ channel: string; payload: unknown }>
} {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    event: {
      sender: {
        isDestroyed: () => destroyed,
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    },
    sent,
  }
}

beforeAll(() => {
  registerTerminalHandlers()
})

beforeEach(() => {
  auditRows.length = 0
  svc.execute.mockClear()
  svc.sync.mockClear()
  svc.kill.mockClear()
  resetStubDialog()
  workspace.dir = null
})

afterAll(() => {
  resetStubDialog()
})

describe('terminal:execute — native confirmation gate', () => {
  it('runs only when the user allows, and audits allowed/confirmed', async () => {
    setStubDialogResponse(0) // 允许执行
    const { event } = fakeEvent()
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'echo hi', undefined, 5000)

    expect(svc.execute).toHaveBeenCalledTimes(1)
    expect(svc.execute.mock.calls[0][0]).toBe('echo hi')
    expect(svc.execute.mock.calls[0][2]).toBe(5000)
    // Window-less overload: options object as the FIRST argument.
    const calls = getStubDialogCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1)
    expect((calls[0][0] as { type: string }).type).toBe('warning')

    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].decision).toBe('allowed')
    expect(auditRows[0].action).toBe('terminal.exec')
    const meta = JSON.parse(auditRows[0].meta ?? '{}')
    expect(meta).toMatchObject({ source: 'renderer-ipc', confirmed: true })
  })

  it('throws and never reaches the service when the user declines (the default)', async () => {
    // resetStubDialog leaves response = 1 (拒绝) — the DEFAULT must deny.
    const { event } = fakeEvent()
    await expect(
      handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'rm -rf /'),
    ).rejects.toThrow(/Execution declined by the user/)

    expect(getStubDialogCalls()).toHaveLength(1) // the dialog really opened
    expect(svc.execute).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].decision).toBe('denied')
    expect(JSON.parse(auditRows[0].meta ?? '{}')).toMatchObject({ confirmed: false })
  })

  it('a dialog that never opens can never allow (denial is the fail-safe)', async () => {
    // Simulate the dialog throwing (renderer crash mid-confirm): the gate must
    // surface the error, not fall through to execution.
    const origShow = dialog.showMessageBox
    dialog.showMessageBox = () => Promise.reject(new Error('dialog gone'))
    try {
      const { event } = fakeEvent()
      await expect(handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'id')).rejects.toThrow(/dialog gone/)
      expect(svc.execute).not.toHaveBeenCalled()
    } finally {
      dialog.showMessageBox = origShow
    }
  })
})

describe('terminal:execute — workspace cwd jail (sessionId)', () => {
  beforeEach(() => {
    workspace.dir = '/tmp/pm-term-ws' // getConversationWorkspaceDir('conv_ws')
  })

  it('rejects a cwd outside the workspace BEFORE the dialog', async () => {
    setStubDialogResponse(0) // even an allow-happy user gets no say here
    const { event } = fakeEvent()
    await expect(
      handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'ls', '/etc', undefined, { sessionId: 'conv_ws' }),
    ).rejects.toThrow(/cwd blocked by sandbox/)

    expect(getStubDialogCalls()).toHaveLength(0) // mechanical check comes first
    expect(svc.execute).not.toHaveBeenCalled()
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].decision).toBe('denied')
    expect(JSON.parse(auditRows[0].meta ?? '{}')).toMatchObject({ reason: 'cwd outside workspace' })
  })

  it('runs inside the workspace after the dialog allows', async () => {
    setStubDialogResponse(0)
    const { event } = fakeEvent()
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'ls', '/tmp/pm-term-ws/sub', undefined, {
      sessionId: 'conv_ws',
    })
    expect(svc.execute).toHaveBeenCalledWith(
      'ls',
      '/tmp/pm-term-ws/sub',
      undefined,
      expect.any(Object),
    )
    expect(getStubDialogCalls()).toHaveLength(1)
  })

  it('defaults the cwd into the workspace when none is given', async () => {
    setStubDialogResponse(0)
    const { event } = fakeEvent()
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'ls', undefined, undefined, {
      sessionId: 'conv_ws',
    })
    expect(svc.execute).toHaveBeenCalledTimes(1)
    expect(svc.execute.mock.calls[0][1]).toBeUndefined() // service default = its own cwd logic
  })

  it('skips the jail (not the dialog) for an unknown conversation', async () => {
    setStubDialogResponse(0)
    const { event } = fakeEvent()
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'ls', '/etc', undefined, {
      sessionId: 'conv_unknown',
    })
    expect(svc.execute).toHaveBeenCalledTimes(1) // no workspace on record → dialog is the only gate
    expect(getStubDialogCalls()).toHaveLength(1)
  })

  it('still demands the dialog for a session whose workspace row is missing', async () => {
    workspace.dir = null
    const { event } = fakeEvent()
    await expect(
      handler(IPC_CHANNELS.TERMINAL_EXECUTE)(event, 'id', undefined, undefined, { sessionId: 'conv_ws' }),
    ).rejects.toThrow(/Execution declined by the user/)
    expect(svc.execute).not.toHaveBeenCalled()
  })
})

describe('terminal:exec-sync — the same gate', () => {
  it('declines without spawning by default', async () => {
    const { event } = fakeEvent()
    await expect(
      handler(IPC_CHANNELS.TERMINAL_EXEC_SYNC)(event, 'cat /etc/shadow'),
    ).rejects.toThrow(/Execution declined by the user/)
    expect(svc.sync).not.toHaveBeenCalled()
    expect(getStubDialogCalls()).toHaveLength(1)
  })

  it('runs after an allow', async () => {
    setStubDialogResponse(0)
    const { event } = fakeEvent()
    const out = await handler(IPC_CHANNELS.TERMINAL_EXEC_SYNC)(event, 'ls', '/tmp', 1000)
    expect(out).toEqual({ output: 'ok', code: 0 })
    expect(svc.sync).toHaveBeenCalledWith('ls', '/tmp', 1000)
  })
})

describe('terminal:kill — deliberately ungated (no execution)', () => {
  it('kills without a dialog', async () => {
    const { event } = fakeEvent()
    await handler(IPC_CHANNELS.TERMINAL_KILL)(event, 'proc_1')
    expect(svc.kill).toHaveBeenCalledWith('proc_1')
    expect(getStubDialogCalls()).toHaveLength(0)
    expect(auditRows).toHaveLength(0)
  })
})

describe('output sinks — disposed-frame guard', () => {
  it('delivers output to a live sender and drops it for a disposed one', async () => {
    setStubDialogResponse(0)
    const live = fakeEvent(false)
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(live.event, 'echo hi')
    const sinks = svc.execute.mock.calls[0][3] as {
      output: (id: string, type: string, data: string) => void
      exit: (id: string, code: number | null, signal: string | null) => void
      error: (id: string, message: string) => void
    }
    sinks.output('p1', 'stdout', 'hello')
    sinks.exit('p1', 0, null)
    expect(live.sent.map((m) => m.channel)).toEqual([
      IPC_CHANNELS.TERMINAL_OUTPUT,
      IPC_CHANNELS.TERMINAL_EXIT,
    ])

    // A crashed/reloaded renderer: its OWN invocation's sinks close over the
    // disposed webContents — send() must not throw out of the sink.
    const dead = fakeEvent(true)
    await handler(IPC_CHANNELS.TERMINAL_EXECUTE)(dead.event, 'echo hi')
    const deadSinks = svc.execute.mock.calls[1][3] as typeof sinks
    expect(() => {
      deadSinks.output('p1', 'stdout', 'x')
      deadSinks.exit('p1', 0, null)
      deadSinks.error('p1', 'boom')
    }).not.toThrow()
    expect(dead.sent).toHaveLength(0)
    expect(live.sent).toHaveLength(2) // untouched by the dead sender's traffic
  })
})
