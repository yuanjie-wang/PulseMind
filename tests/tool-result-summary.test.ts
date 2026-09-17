import { describe, expect, it } from 'vitest'
import { resultSummary } from '../src/shared/tool-display/result-summary'

/** PLAN-tool-ux T3 / D3-B：按家族解析输出计数；解析失败回落 null（调用方
 *  因此照旧展示原文，绝不编造数字）。纯函数——桌面与面板共用。 */

const exec = (stdout: string, stderr = ''): string =>
  [`Exit Code: 0  |  Total: ${stdout.length} chars  |  Stderr: ${stderr ? stderr.split('\n').length : 0} lines`, '', '--- stdout ---', stdout || '(empty)', stderr ? `--- stderr ---\n${stderr}` : ''].join('\n')

describe('resultSummary', () => {
  it('read → 行数 from the metadata header', () => {
    const out = ['--- File Metadata ---', '  Path: /tmp/a.ts', '  Size: 12.3 KB (1,204 lines)', '  Range: lines 1-1204', '--- End File Metadata ---', '', 'content'].join('\n')
    expect(resultSummary('read', out)).toEqual({ line: '1,204 行' })
  })

  it('read without metadata → null (fall back to raw output)', () => {
    expect(resultSummary('read', 'plain converted markdown')).toBeNull()
    expect(resultSummary('read', undefined)).toBeNull()
  })

  it('search → stdout line count as 匹配数', () => {
    const out = exec(['src/a.ts:12: foo', 'src/b.ts:40: bar', 'src/c.ts:1: baz'].join('\n'))
    expect(resultSummary('search', out)).toEqual({ line: '3 处匹配' })
  })

  it('search with no hits → null', () => {
    expect(resultSummary('search', exec('(empty)'))).toBeNull()
  })

  it('list_dir / find → 项数, stderr excluded', () => {
    const out = exec(['dirA', 'file1.ts', 'file2.ts'].join('\n'), 'warning noise')
    expect(resultSummary('list_dir', out)).toEqual({ line: '3 项' })
    expect(resultSummary('find', out)?.line).toBe('3 项')
  })

  it('unknown family → null', () => {
    expect(resultSummary('exec', exec('anything'))).toBeNull()
    expect(resultSummary('git_status', '## main')).toBeNull()
  })
})
