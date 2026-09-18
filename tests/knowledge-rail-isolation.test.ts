// Knowledge rail isolation (2026-09-18): the knowledge center is two columns —
// the left rail lists bases, its selection IS the scope, and the right side
// (table / stats / search / import target / compile / rebuild / wiki preview)
// must never cross it. vitest here is node-env: the pane cannot be mounted, so
// the wiring is asserted as source, the same way tests/knowledge-panel-search-mode
// and tests/expert-delegation pin their chains. The interaction itself is
// probed by scripts/probe-knowledge-layout.mjs in real Chromium.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const handler = read('src/main/ipc/knowledge.handler.ts')
const preload = read('src/preload/index.ts')
const bridge = read('src/shared/types/electron-bridge.ts')
const manager = read('src/renderer/src/knowledge/KnowledgeManager.ts')
const panel = read('src/renderer/src/components/knowledge/KnowledgePanel.tsx')
const centers = read('src/renderer/src/components/centers/CentersPage.tsx')
const rail = read('src/renderer/src/components/knowledge/KnowledgeBaseList.tsx')
const navTypes = read('src/renderer/src/navigation/types.ts')
const zh = read('src/renderer/src/i18n/locales/zh.ts')
const en = read('src/renderer/src/i18n/locales/en.ts')

describe('knowledge rail isolation — the baseId travels the whole chain', () => {
  it('non-vacuity: the scans read real sources (a broken path cannot pass by finding nothing)', () => {
    expect(handler).toContain('registerKnowledgeHandlers')
    expect(preload).toContain('knowledgeListAdvanced')
    expect(panel).toContain('scopedBaseId')
    expect(rail).toContain('data-base-item')
  })

  // The service layer always accepted baseId (knowledge-queries.ts) — the IPC
  // boundary used to drop it, which made every scoped call a silent global one
  // (the agent's km.searchContent(query, scopeBaseId) included). These pin the
  // boundary, not the service.
  it('the IPC handlers forward baseId for search / wiki-search / rebuild / wiki-dir', () => {
    expect(handler).toContain('svcSearchContent(query, baseId)')
    expect(handler).toContain('svcSearchWiki(query, baseId)')
    expect(handler).toContain('svcRebuildWiki(baseId)')
    expect(handler).toContain('svcGetWikiDir(baseId)')
  })

  it('preload forwards the same parameters', () => {
    expect(preload).toContain('KNOWLEDGE_SEARCH_CONTENT, query, baseId')
    expect(preload).toContain('KNOWLEDGE_SEARCH_WIKI, query, baseId')
    expect(preload).toContain('KNOWLEDGE_REBUILD_WIKI, baseId')
    expect(preload).toContain('KNOWLEDGE_GET_WIKI_DIR, baseId')
  })

  it('the ElectronAPI contract declares the parameters', () => {
    expect(bridge).toMatch(/knowledgeRebuildWiki: \(baseId\?: string\)/)
    expect(bridge).toMatch(/knowledgeGetWikiDir: \(baseId\?: string\)/)
  })

  it('the manager passes baseId through to the host', () => {
    expect(manager).toContain('knowledgeRebuildWiki(baseId)')
    expect(manager).toMatch(/rebuildWiki\(baseId\?: string\)/)
  })

  it('the panel scopes EVERY surface to its baseId prop', () => {
    expect(panel).toContain('const scopedBaseId = baseId ?? DEFAULT_BASE_ID')
    // the list query + stats
    expect(panel).toContain('baseId: scopedBaseId,')
    expect(panel).toContain('knowledgeManager.getStats(scopedBaseId)')
    // full-text search
    expect(panel).toContain('knowledgeManager.searchContent(searchQuery, scopedBaseId)')
    // compile-all + rebuild re-enqueue: raw files of THIS base only
    expect(panel).toContain("listFilesAdvanced({ status: 'raw', baseId: scopedBaseId })")
    expect(panel).toContain('knowledgeManager.rebuildWiki(scopedBaseId)')
    // URL dedup is per-base (the same URL may live in two bases)
    expect(panel).toContain('f.baseId === scopedBaseId')
    // the wiki preview resolves against the file's OWN base dir
    expect(panel).toContain('knowledgeGetWikiDir(record.baseId)')
  })

  it('the pane feeds the panel the rail\u2019s selection and carries no detached target select', () => {
    expect(centers).toContain('baseId={selectedBaseId}')
    // the old「导入到」dropdown — a target without a view — must not return
    expect(centers).not.toContain('knowledge-import-target')
    expect(centers).not.toContain('导入到：')
    // imports ride the selection
    expect(centers).toContain('handleAddFile(selectedBaseId)')
    expect(centers).toContain('handleAddFolder(selectedBaseId)')
  })

  it('the selection rides the navigation view params (survives tab switches)', () => {
    expect(navTypes).toMatch(/knowledgeBaseId\?: string/)
    expect(centers).toContain('view.knowledgeBaseId')
  })
})

describe('knowledge rail — base management lives on the rail', () => {
  it('rename is reachable (svcRenameBase had no UI entry before the rail)', () => {
    expect(rail).toContain('knowledgeManager.renameBase(')
    expect(zh).toMatch(/renameBaseTitle: '.+'/)
    expect(en).toMatch(/renameBaseTitle: '.+'/)
  })

  it('the default base renders but carries no actions', () => {
    expect(rail).toContain('DEFAULT_BASE_ID')
    expect(rail).toMatch(/deletable = b\.id !== DEFAULT_BASE_ID/)
  })

  it('the delete confirm states the real semantics — the files go WITH the base', () => {
    // The store really deletes them (probe-knowledge-base asserts it); the old
    //「文件将回到默认库」wording described a behaviour the backend never had.
    expect(zh).toContain('将一并删除，且不可恢复')
    expect(en).toContain('will be deleted together with it')
  })

  it('both locales carry the rail copy', () => {
    for (const locale of [zh, en]) {
      expect(locale).toMatch(/baseNew: '.+'/)
      expect(locale).toMatch(/baseDefaultTag: '.+'/)
      expect(locale).toMatch(/baseNamePlaceholder: '.+'/)
    }
  })
})
