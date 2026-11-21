export type GitAction =
  | { action: 'is_repo'; cwd: string }
  | { action: 'status'; cwd: string }
  | { action: 'diff'; cwd: string; files?: string[]; staged?: boolean; statOnly?: boolean }
  | { action: 'log'; cwd: string; n?: number }
  | { action: 'commit'; cwd: string; message: string; files?: string[] }
  | { action: 'restore'; cwd: string; files: string[]; confirm?: boolean }
  | { action: 'branch_list'; cwd: string }
  | { action: 'switch'; cwd: string; name: string }
  | { action: 'branch_create'; cwd: string; name: string; from?: string }

export interface GitStatusInfo {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
  conflict: string[]
}

/** One local or remote branch for the composer's branch picker. A repo with
 *  no commits yet has no refs at all: both lists are empty and `head` is null. */
export interface GitBranchEntry {
  name: string
  head: string | null
  summary: string
  ahead: number
  behind: number
  current: boolean
}

/** `current === null` means a detached HEAD; `head` then names the commit.
 *  `isRepo: false` outside a work tree, so the picker can simply not render. */
export interface GitBranchList {
  isRepo: boolean
  current: string | null
  detached: boolean
  head: string | null
  local: GitBranchEntry[]
  remote: GitBranchEntry[]
}

/** Common result of switch / branch_create — enough to name the transition in
 *  a toast without another round trip. */
export interface GitBranchMutation {
  name: string
  previous: string | null
}

export interface GitCommitResult {
  hash: string
  shortHash: string
  summary: string
  filesChanged: number
}

export interface GitLogEntry {
  hash: string
  shortHash: string
  summary: string
}

export interface GitDiffResult {
  isRepo: boolean
  stat?: string
  diff?: string
}

export interface GitRestorePreview {
  isRepo: boolean
  stat: string
  status: string
  message: string
}

export interface GitResult<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: number; message: string }
}
