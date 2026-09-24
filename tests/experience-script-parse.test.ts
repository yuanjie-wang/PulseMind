import { describe, expect, it } from 'vitest'
import { parseScriptFences, MAX_SCRIPTS_PER_EXPERIENCE } from '../src/shared/experience/script-fence'

const fence = (path: string, body: string, lang = 'js'): string =>
  `### File: ${path}\n\`\`\`${lang}\n${body}\n\`\`\``

describe('parseScriptFences — the text protocol keeps working without scripts', () => {
  it('plain content passes through untouched, no files', () => {
    const r = parseScriptFences('## 背景\n something\n## 优化\n done')
    expect(r.content).toBe('## 背景\n something\n## 优化\n done')
    expect(r.files).toEqual([])
    expect(r.rejected).toEqual([])
  })

  it('a normal fence is split out of the content', () => {
    const raw = '正文开头\n\n' + fence('scripts/agg.mjs', 'console.log(1)') + '\n\n正文结尾'
    const r = parseScriptFences(raw)
    expect(r.files).toEqual([{ path: 'scripts/agg.mjs', content: 'console.log(1)' }])
    expect(r.content).toContain('正文开头')
    expect(r.content).toContain('正文结尾')
    expect(r.content).not.toContain('console.log(1)')
    expect(r.rejected).toEqual([])
  })
})

describe('parseScriptFences — the gates', () => {
  it('a non-scripts/ path is rejected, its body removed from the content', () => {
    const raw = fence('/etc/passwd', 'evil') + '\n剩余正文'
    const r = parseScriptFences(raw)
    expect(r.files).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].reason).toContain('scripts/')
    expect(r.content).not.toContain('evil')
  })

  it('an unclosed fence drops the file AND everything after it (truncation)', () => {
    const raw = '## 脚本 (Script)\n' + fence('scripts/a.mjs', 'const ok = 1') + '\n\nafter\n' + '### File: scripts/b.mjs\n```js\nconst broken ='
    const r = parseScriptFences(raw)
    expect(r.files).toHaveLength(1)
    expect(r.files[0].path).toBe('scripts/a.mjs')
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].path).toBe('scripts/b.mjs')
    // Lines BEFORE the truncated fence are honest text — kept; the truncated
    // fence itself and everything inside it are gone.
    expect(r.content).toContain('after')
    expect(r.content).not.toContain('const broken')
  })

  it('more than MAX files: the overflow is rejected', () => {
    const raw = [1, 2, 3, 4].map((i) => fence(`scripts/s${i}.mjs`, `const x${i} = ${i}`)).join('\n')
    const r = parseScriptFences(raw)
    expect(r.files).toHaveLength(MAX_SCRIPTS_PER_EXPERIENCE)
    expect(r.rejected).toEqual([{ path: 'scripts/s4.mjs', reason: expect.stringContaining('more than') }])
  })

  it('a fence with no opening code block is rejected without killing the rest', () => {
    const raw = '### File: scripts/odd.mjs\nno fence here\n\n' + fence('scripts/ok.mjs', 'const a = 1')
    const r = parseScriptFences(raw)
    expect(r.files).toEqual([{ path: 'scripts/ok.mjs', content: 'const a = 1' }])
    expect(r.rejected).toHaveLength(1)
  })
})
