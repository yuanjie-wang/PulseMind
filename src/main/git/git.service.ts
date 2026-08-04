import { execFile } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  GitAction,
  GitCommitResult,
  GitDiffResult,
  GitLogEntry,
  GitResult,
  GitRestorePreview,
  GitStatusInfo,
} from '../../shared/types/git'

const GIT_MAX_BUFFER = 32 * 1024 * 1024 // 32MB
const GIT_TIMEOUT = 15_000 // 15s

/** PATH candidates, probing absolute install locations as a fallback for GUI-launched apps with a minimal PATH. */
const GIT_CANDIDATES: string[] = (() => {
  const list = ['git']
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (pf) list.push(resolve(pf, 'Git', 'cmd', 'git.exe'))
    }
  } else {
    list.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git')
  }
  return list
})()

let cachedGitBin: string | null = null

class GitExecError extends Error {
  constructor(
    readonly code: number,
    readonly stderr: string,
    readonly stdout: string = '',
  ) {
    super(stderr.trim() || `git exited with code ${code}`)
  }

  isNotRepo(): boolean {
    return this.code === 128 && /not a git repository/i.test(this.stderr)
  }
}

interface ExecResult {
  stdout: string
  stderr: string
}

/** Run git with an args array (never a shell string). Falls back across GIT_CANDIDATES on ENOENT. */
async function execGit(args: string[], cwd: string, input?: string): Promise<ExecResult> {
  if (!cwd) throw new GitExecError(1, 'cwd is required', '')
  const absCwd = resolve(cwd)
  // Print non-ASCII file names verbatim (UTF-8) instead of octal escapes like "\346\265\213\350\257\225".
  // Applies to every git invocation — cross-platform (Windows + macOS).
  args = ['-c', 'core.quotepath=false', ...args]
  const st = await stat(absCwd).catch(() => null)
  if (!st || !st.isDirectory()) {
    throw new GitExecError(1, `cwd is not a directory: ${absCwd}`, '')
  }

  const order = cachedGitBin ? [cachedGitBin, ...GIT_CANDIDATES.filter((c) => c !== cachedGitBin)] : GIT_CANDIDATES
  for (const bin of order) {
    if (bin !== 'git') {
      const exists = await access(bin).then(
        () => true,
        () => false,
      )
      if (!exists) continue
    }
    cachedGitBin = bin
    try {
      return await runGit(bin, args, absCwd, input)
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') continue // binary not on PATH — try next
      throw err
    }
  }
  throw new GitExecError(127, 'git binary not found on PATH')
}

function runGit(bin: string, args: string[], cwd: string, input?: string): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      bin,
      args,
      { cwd, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
          return
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const e = new Error(`git not found: ${bin}`) as NodeJS.ErrnoException
          e.code = 'ENOENT'
          reject(e)
          return
        }
        const code = typeof error.code === 'number' ? error.code : 1
        reject(new GitExecError(code, String(stderr), String(stdout)))
      },
    )
    // git commit -F - reads the message from stdin
    child.stdin?.end(input)
  })
}

// ── porcelain v1 parser ──────────────────────────────────────────────
const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'])

function parsePorcelainStatus(raw: string): GitStatusInfo {
  const result: GitStatusInfo = {
    isRepo: true,
    branch: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflict: [],
  }
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const rest = line.slice(3)
      const branchPart = rest.split('...')[0].split(' [')[0].trim()
      result.branch = branchPart === 'HEAD (no branch)' || branchPart === 'HEAD' ? null : branchPart
      const meta = rest.match(/\[(.*)\]/)?.[1] ?? ''
      const ahead = meta.match(/ahead (\d+)/)?.[1]
      const behind = meta.match(/behind (\d+)/)?.[1]
      result.ahead = ahead ? Number(ahead) : 0
      result.behind = behind ? Number(behind) : 0
      continue
    }
    const code = line.slice(0, 2)
    const path = line.slice(3)
    if (code === '??') {
      result.untracked.push(path)
      continue
    }
    if (CONFLICT_CODES.has(code)) {
      result.conflict.push(path)
      continue
    }
    const x = code[0]
    const y = code[1]
    if (x !== ' ' && x !== '?') result.staged.push(path)
    if (y !== ' ' && y !== '?') result.unstaged.push(path)
  }
  return result
}

async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel'], cwd)
    return stdout.trim() || null
  } catch {
    return null
  }
}

// ── operations ───────────────────────────────────────────────────────

export async function checkIsRepo(cwd: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], cwd)
    return true
  } catch {
    return false
  }
}

export async function gitStatus(cwd: string): Promise<GitStatusInfo> {
  try {
    const { stdout } = await execGit(['status', '--porcelain=v1', '-b', '--untracked-files=all'], cwd)
    return parsePorcelainStatus(stdout)
  } catch (err) {
    if (err instanceof GitExecError && err.isNotRepo()) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflict: [] }
    }
    throw err
  }
}

export async function gitDiff(cwd: string, files?: string[], staged?: boolean, statOnly?: boolean): Promise<GitDiffResult> {
  const args = ['diff', ...(staged ? ['--cached'] : []), ...(statOnly ? ['--stat'] : ['-U80'])]
  if (files?.length) args.push('--', ...files)
  try {
    const { stdout } = await execGit(args, cwd)
    return { isRepo: true, stat: statOnly ? stdout : undefined, diff: statOnly ? undefined : stdout }
  } catch (err) {
    if (err instanceof GitExecError && err.isNotRepo()) return { isRepo: false }
    throw err
  }
}

export async function gitLog(cwd: string, n?: number): Promise<GitLogEntry[]> {
  const count = n && n > 0 ? n : 20
  const { stdout } = await execGit(['log', '--oneline', '-n', String(count)], cwd)
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(' ')
      const hash = sp === -1 ? line : line.slice(0, sp)
      const summary = sp === -1 ? '' : line.slice(sp + 1)
      return { hash, shortHash: hash.slice(0, 7), summary }
    })
}

export async function gitCommit(cwd: string, message: string, files?: string[]): Promise<GitCommitResult> {
  if (files?.length) await execGit(['add', '--', ...files], cwd)
  await execGit(['commit', '-F', '-'], cwd, message)
  const { stdout: fullHash } = await execGit(['rev-parse', 'HEAD'], cwd)
  const { stdout: shortHash } = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
  let filesChanged = 0
  try {
    const { stdout } = await execGit(['show', '--stat', '--oneline', 'HEAD'], cwd)
    const m = stdout.match(/(\d+) files? changed/)
    if (m) filesChanged = Number(m[1])
  } catch {
    // commit just created HEAD — show --stat should not fail
  }
  return { hash: fullHash.trim(), shortHash: shortHash.trim(), summary: message, filesChanged }
}

export async function gitRestore(
  cwd: string,
  files: string[],
  confirm?: boolean,
): Promise<GitRestorePreview | { restored: string[] }> {
  if (!confirm) {
    const statOut = await execGit(['diff', '--stat', '--', ...files], cwd)
    const statusOut = await execGit(['status', '--porcelain=v1', '--', ...files], cwd)
    return {
      isRepo: true,
      stat: statOut.stdout,
      status: statusOut.stdout,
      message: 'Preview only — pass confirm:true to execute `git restore -- {files}`.',
    }
  }

  const root = await repoRoot(cwd)
  if (!root) throw new GitExecError(128, 'not a git repository', '')
  const cwdAbs = await realpath(resolve(cwd))
  for (const f of files) {
    const resolved = await realpath(resolve(cwdAbs, f)).catch(() => resolve(cwdAbs, f))
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new GitExecError(1, `file outside repository: ${f}`, '')
    }
  }
  await execGit(['restore', '--', ...files], cwd)
  return { restored: files }
}

export async function invokeGitAction(action: GitAction): Promise<GitResult> {
  try {
    switch (action.action) {
      case 'is_repo': {
        const data = { isRepo: await checkIsRepo(action.cwd) }
        return { ok: true, data }
      }
      case 'status': {
        const data = await gitStatus(action.cwd)
        return { ok: true, data }
      }
      case 'diff': {
        const data = await gitDiff(action.cwd, action.files, action.staged, action.statOnly)
        return { ok: true, data }
      }
      case 'log': {
        const data = await gitLog(action.cwd, action.n)
        return { ok: true, data }
      }
      case 'commit': {
        if (!action.message?.trim()) return { ok: false, error: { code: 1, message: 'commit message is required' } }
        const data = await gitCommit(action.cwd, action.message, action.files)
        return { ok: true, data }
      }
      case 'restore': {
        if (!action.files?.length) return { ok: false, error: { code: 1, message: 'restore requires files' } }
        const data = await gitRestore(action.cwd, action.files, action.confirm)
        return { ok: true, data }
      }
      default: {
        const _exhaustive: never = action
        return { ok: false, error: { code: 1, message: `unknown git action: ${JSON.stringify(_exhaustive)}` } }
      }
    }
  } catch (err) {
    if (err instanceof GitExecError) return { ok: false, error: { code: err.code, message: err.message } }
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: { code: 1, message: msg } }
  }
}
