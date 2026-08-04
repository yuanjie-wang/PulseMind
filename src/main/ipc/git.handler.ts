import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { GitAction, GitResult } from '../../shared/types/git'
import { invokeGitAction } from '../git/git.service'

/** Basic shape guard — the service does the authoritative work. */
function isGitAction(value: unknown): value is GitAction {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.action === 'string' && typeof v.cwd === 'string' && v.cwd.length > 0
}

export function registerGitHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GIT_INVOKE, async (_event, action: GitAction): Promise<GitResult> => {
    if (!isGitAction(action)) {
      return { ok: false, error: { code: 1, message: 'invalid git action' } }
    }
    return invokeGitAction(action)
  })
}
