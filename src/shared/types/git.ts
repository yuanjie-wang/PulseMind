export type GitAction =
  | { action: 'is_repo'; cwd: string }
  | { action: 'status'; cwd: string }
  | { action: 'diff'; cwd: string; files?: string[]; staged?: boolean; statOnly?: boolean }
  | { action: 'log'; cwd: string; n?: number }
  | { action: 'commit'; cwd: string; message: string; files?: string[] }
  | { action: 'restore'; cwd: string; files: string[]; confirm?: boolean }

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
