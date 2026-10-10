// reextractKnowledge 不许再丢 frontmatter（2026-10-10 审计 #12）。
// 导入路径写 frontmatter + 正文（buildFrontmatter(:785-791)），重提取却裸写
// cleanContent——一次「重新提取」就把 raw 文件的 title/source_path/extracted
// 头永久抹掉，且无人报错。knowledge-store 需要真库（better-sqlite3 是
// Electron-ABI），vitest 只能像 knowledge-row-actions-wiring 一样以源码钉住
// 写盘形状：重建 frontmatter 且字段取自行记录、extracted 刷新。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const store = readFileSync(join(ROOT, 'src/main/storage/knowledge-store.ts'), 'utf-8')

describe('reextractKnowledge rebuilds the raw file frontmatter', () => {
  it('writes frontmatter + body, with the row-sourced fields the import path uses', () => {
    // 非 vacuity：构建 frontmatter 的调用必须出现在 reextract 的写盘之前。
    const reextractBody = store.slice(store.indexOf('export async function reextractKnowledge'))
    expect(reextractBody).toContain('buildFrontmatter({')
    expect(reextractBody).toContain('title: row.title')
    expect(reextractBody).toContain("source_type: row.source_type || 'file'")
    expect(reextractBody).toContain('source_path: row.source_path')
    expect(reextractBody).toContain('extracted: localTimestamp()')
    expect(reextractBody).toContain("writeFileSync(fullPath, frontmatter + cleanContent, 'utf-8')")
  })

  it('the content hash still covers the BODY only, matching the import path', () => {
    // hash 口径两侧必须一致（导入 :822 也只算 cleanContent），否则每次重提取
    // 都会因 hash 漂移把文件误判成已变更。
    const reextractBody = store.slice(store.indexOf('export async function reextractKnowledge'))
    expect(reextractBody).toContain("createHash('sha256').update(cleanContent).digest('hex')")
    expect(reextractBody.indexOf('createHash')).toBeLessThan(reextractBody.indexOf('buildFrontmatter'))
  })
})
