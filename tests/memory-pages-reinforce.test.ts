import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  appendRecurrenceNote,
  deriveMaturity,
  RECURRENCE_NOTE_MAX,
  type MemoryPageFile,
} from '../src/shared/memory-pages'

/** PLAN-experience-sop 刀一的纯逻辑层：files⇒maturity 派生、重现记录 FIFO。
 *  DB 侧行为（reinforce 落库、护栏、touch）由 scripts/probe-memory-pages-sop.mjs
 *  驱动真库验证——better-sqlite3 是 Electron-ABI，vitest 开不了库。 */

const file = (path: string): MemoryPageFile => ({ path, content: `// ${path}\nconsole.log(1)` })

describe('deriveMaturity：files ⇒ sop 的唯一派生规则', () => {
  it('带脚本 ⇒ sop', () => {
    expect(deriveMaturity([file('scripts/a.mjs')])).toBe('sop')
  })
  it('null / 空数组 ⇒ clue', () => {
    expect(deriveMaturity(null)).toBe('clue')
    expect(deriveMaturity(undefined)).toBe('clue')
    expect(deriveMaturity([])).toBe('clue')
  })
})

describe('appendRecurrenceNote：## 重现记录 节', () => {
  it('无节时新建节并追加一行', () => {
    const body = appendRecurrenceNote('## 背景\n手工部署八步。', '发布流程又手动走了八步', '2026-10-26')
    expect(body).toContain('## 背景')
    expect(body).toContain('## 重现记录')
    expect(body).toContain('- 2026-10-26 发布流程又手动走了八步')
    expect(body.indexOf('## 重现记录')).toBeGreaterThan(body.indexOf('## 背景'))
  })

  it('已有节时新行置顶（最新在上）', () => {
    const first = appendRecurrenceNote('正文', '第一次重现', '2026-10-25')
    const second = appendRecurrenceNote(first, '第二次重现', '2026-10-26')
    const lines = second.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toEqual(['- 2026-10-26 第二次重现', '- 2026-10-25 第一次重现'])
  })

  it(`FIFO 截尾 ≤${RECURRENCE_NOTE_MAX} 条`, () => {
    let body = '正文'
    for (let i = 1; i <= RECURRENCE_NOTE_MAX + 5; i++) {
      body = appendRecurrenceNote(body, `第 ${i} 次重现`, `2026-01-${String(i % 28 + 1).padStart(2, '0')}`)
    }
    const lines = body.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(RECURRENCE_NOTE_MAX)
    expect(lines[0]).toContain(`第 ${RECURRENCE_NOTE_MAX + 5} 次重现`)
    expect(lines[lines.length - 1]).toContain(`第 6 次重现`) // 最旧的 5 条被截掉
  })

  it('节前的正文保持原样（重复追加不腐蚀正文）', () => {
    let body = '## 背景\nA。\n## 优化\nB。'
    for (let i = 0; i < 3; i++) body = appendRecurrenceNote(body, `第 ${i} 次`, '2026-10-26')
    expect(body).toContain('## 优化\nB。')
    expect(body.split('## 重现记录')).toHaveLength(2) // 节不重复创建
  })
})

describe('接线（DB 行为见 probe-memory-pages-sop.mjs）', () => {
  const read = (p: string) => readFileSync(p, 'utf-8')
  it('database.ts：CREATE TABLE 带三列 + ALTER 迁移在位', () => {
    const db = read('src/main/storage/database.ts')
    expect(db).toMatch(/memory_pages \([\s\S]*maturity\s+TEXT NOT NULL DEFAULT 'clue'/)
    expect(db).toContain('ADD COLUMN maturity TEXT NOT NULL DEFAULT')
    expect(db).toContain('ADD COLUMN recurrence INTEGER NOT NULL DEFAULT 0')
    expect(db).toContain('ADD COLUMN last_reinforced_at TEXT')
  })
  it('MemoryManager：compile pass 目录排除 SOP 页（园丁不修电器）', () => {
    const src = read('src/renderer/src/memory/MemoryManager.ts')
    expect(src).toContain("p.maturity !== 'sop'")
  })
  it('经验卡 SOP 徽标接线', () => {
    const src = read('src/renderer/src/components/knowledge/MemoryPagesPanel.tsx')
    expect(src).toContain("p.maturity === 'sop'")
    expect(src).toContain('memoryPages.sopBadge')
  })
  it('i18n 双语键在位', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('sopBadge:')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('sopBadge:')
  })
})
