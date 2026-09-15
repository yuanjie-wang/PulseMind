// ── shared/workspace-path: the project modal's instant verdicts ──
// Format errors answer on every keystroke (the fs probe is main-side and
// debounced), and a blank project name is auto-filled from the path's last
// segment. The main process never expands `~` — ensureWorkspaceDir mkdirs the
// raw string — so a home shorthand must be rejected here, not resolved.

import { describe, it, expect } from 'vitest'
import { checkWorkspacePathFormat, basenameOfPath, windowsReservedNameError } from '../src/shared/workspace-path'

describe('checkWorkspacePathFormat', () => {
  it('accepts POSIX absolute and Windows drive/UNC paths', () => {
    expect(checkWorkspacePathFormat('/Users/me/code')).toBeNull()
    expect(checkWorkspacePathFormat('  /Users/me/code  ')).toBeNull()
    expect(checkWorkspacePathFormat('C:\\code\\my-app')).toBeNull()
    expect(checkWorkspacePathFormat('C:/code/my-app')).toBeNull()
    expect(checkWorkspacePathFormat('\\\\server\\share\\proj')).toBeNull()
  })

  it('rejects relative paths', () => {
    expect(checkWorkspacePathFormat('code/my-app')).toContain('绝对路径')
    expect(checkWorkspacePathFormat('./code')).toContain('绝对路径')
    expect(checkWorkspacePathFormat('C:code')).toContain('绝对路径')
  })

  it('rejects ~ shorthand — the main process would mkdir a literal "~" folder', () => {
    expect(checkWorkspacePathFormat('~')).toContain('~')
    expect(checkWorkspacePathFormat('~/code')).toContain('~')
    expect(checkWorkspacePathFormat('~\\code')).toContain('~')
  })

  it('rejects empty input and NUL bytes', () => {
    expect(checkWorkspacePathFormat('')).toContain('请填写')
    expect(checkWorkspacePathFormat('   ')).toContain('请填写')
    expect(checkWorkspacePathFormat('/bad\0path')).toContain('非法')
  })
})

describe('basenameOfPath', () => {
  it('returns the last segment across both separators and trailing slashes', () => {
    expect(basenameOfPath('/Users/me/code/my-app')).toBe('my-app')
    expect(basenameOfPath('/Users/me/code/my-app/')).toBe('my-app')
    expect(basenameOfPath('C:\\code\\my-app\\')).toBe('my-app')
  })

  it('returns "" for roots and separator-only strings — nothing to name a project after', () => {
    expect(basenameOfPath('/')).toBe('')
    expect(basenameOfPath('C:\\')).toBe('')
    expect(basenameOfPath('//')).toBe('')
    expect(basenameOfPath('')).toBe('')
  })
})

describe('windowsReservedNameError', () => {
  it('flags reserved device names in any segment, with or without an extension', () => {
    expect(windowsReservedNameError('C:\\code\\CON')).toContain('CON')
    expect(windowsReservedNameError('C:\\NUL.txt\\app')).toContain('NUL')
    expect(windowsReservedNameError('/data/COM1/proj')).toContain('COM1')
  })

  it('accepts names that merely start the same way', () => {
    expect(windowsReservedNameError('C:\\code\\console-app')).toBeNull()
    expect(windowsReservedNameError('C:\\code\\COM10')).toBeNull()
    expect(windowsReservedNameError('/Users/me/normal')).toBeNull()
  })
})
