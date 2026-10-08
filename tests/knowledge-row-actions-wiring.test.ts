// ── Knowledge row actions must be honest about where they lead ──
// Two user reports from 2026-10-08 (live-reproduced in the running app):
// 1. 查看编译结果 opened a workbench preview TAB — but the workbench pane only
//    renders in the chat view (AppLayout: "The workbench pane only renders for
//    an open conversation in the chat view"), so from the knowledge center the
//    click wrote invisible store state. The button now reads the wiki page into
//    the panel's OWN compiledPreview modal (the same surface 预览 uses).
// 2. With only the default base, the per-row 移动到知识库 dropdown had zero
//    items — a click flashed an empty menu, which reads as a greyed/dead
//    button. The state is now rendered honestly (disabled + explanatory
//    tooltip), same for the batch-move Select.
// vitest is node-env (the panel cannot be mounted), so the wiring is asserted
// as source — the same discipline as knowledge-panel-search-mode.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const panel = readFileSync(join(ROOT, 'src/renderer/src/components/knowledge/KnowledgePanel.tsx'), 'utf-8')

describe('查看编译结果 stays inside the knowledge center', () => {
  it('reads the wiki output into the panel preview modal', () => {
    // Non-vacuity: the modal is the surface 预览 already uses.
    expect(panel).toContain('setCompiledPreview({ visible: true, content, title: file.title })')
    expect(panel).toMatch(/readWiki\(record\.wikiOutputs!\[0\], record\.baseId\)/)
    expect(panel).toMatch(/setCompiledPreview\(\{ visible: true, content, title: `\$\{record\.title\} · 编译结果` \}\)/)
  })

  it('never routes wiki output to the workbench preview pane', () => {
    // The regression shape: openInPreviewPane from a centers-view panel mutates
    // store state nothing on this page renders. If it ever comes back here, the
    // button goes silently dead again.
    expect(panel).not.toContain('openInPreviewPane')
    expect(panel).not.toContain('knowledgeGetWikiDir')
  })
})

describe('move affordances with a single base', () => {
  it('the row button renders disabled with an explanatory tooltip when no other base exists', () => {
    expect(panel).toMatch(/bases\.filter\(\(b\) => b\.id !== record\.baseId\)\.length > 0 \?/)
    expect(panel).toContain('只有当前知识库，无其他知识库可移动')
    expect(panel).toMatch(/<Button type="text" size="small" icon=\{<GroupOutlined \/>\} disabled/)
  })

  it('the batch-move Select is disabled in the same state', () => {
    expect(panel).toMatch(/disabled=\{bases\.length < 2\}/)
  })
})
