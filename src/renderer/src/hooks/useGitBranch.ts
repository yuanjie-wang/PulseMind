// Git branch state for the composer's branch picker. The cwd is the PROJECT's
// directory (not the conversation's timestamped workspace): that is the tree
// the user thinks of as "the repo". Plain conversations pass no project id, so
// the picker never mounts a git call for them.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../stores/projectStore'
import type { GitBranchList, GitStatusInfo } from '../../../shared/types/git'

interface GitBranchState {
  status: GitStatusInfo | null
  branches: GitBranchList | null
  loading: boolean
  error: string | null
}

const INITIAL: GitBranchState = { status: null, branches: null, loading: false, error: null }

export function useGitBranch(
  gitProjectId: string | undefined,
  workspaceDir: string | undefined,
  open: boolean,
): GitBranchState & { cwd: string | null; refresh: () => Promise<void> } {
  const projectDir = useProjectStore((s) =>
    gitProjectId ? s.projects.find((p) => p.id === gitProjectId)?.workspaceDir : undefined,
  )
  const cwd = projectDir ?? workspaceDir ?? null
  const [state, setState] = useState<GitBranchState>(INITIAL)
  // A slow status/branch_list pair from a previous cwd must not overwrite the
  // current one after a conversation switch.
  const seq = useRef(0)

  // The shared project list is normally loaded by the sidebar/welcome picker;
  // a composer mounted first (or in a popout window) still needs the directory.
  useEffect(() => {
    if (gitProjectId && !useProjectStore.getState().loaded) {
      void useProjectStore.getState().reload()
    }
  }, [gitProjectId])

  const refresh = useCallback(async (): Promise<void> => {
    if (!cwd) return
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const [st, br] = await Promise.all([
        window.electronAPI.gitInvoke({ action: 'status', cwd }),
        window.electronAPI.gitInvoke({ action: 'branch_list', cwd }),
      ])
      if (id !== seq.current) return
      if (!st.ok || !br.ok) {
        throw new Error(st.error?.message ?? br.error?.message ?? 'git invoke failed')
      }
      setState({
        status: st.data as GitStatusInfo,
        branches: br.data as GitBranchList,
        loading: false,
        error: null,
      })
    } catch (err) {
      if (id !== seq.current) return
      setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }))
    }
  }, [cwd])

  // Refresh on cwd change, on panel open, and when the window regains focus
  // (catches a branch switch made in a terminal / IDE). Deliberately NOT per
  // agent turn: system-prompt-builder already does one status call per loop.
  useEffect(() => {
    void refresh()
  }, [refresh, open])
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { cwd, ...state, refresh }
}
