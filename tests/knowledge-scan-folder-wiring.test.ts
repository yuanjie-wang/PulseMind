// ── 知识中心「导入文件夹」— the scan contract across five layers ──
// The user report 「知识中心导入文件夹无效」 was a shape mismatch nobody could
// see: the preload bridge declares `knowledgeScanFolder → { fileCount,
// filePaths }`, the IPC handler answered `svcScanFolder`'s bare `string[]`,
// the renderer destructured `undefined`, `prepareImport(undefined)` threw — and
// `handleAddFolder` had no catch, so choosing a folder did nothing at all. Only
// the agent host wrapped it, which is exactly how the two paths drifted.
//
// vitest is node-env (no ipcMain, no Electron dialog) and the runtime half —
// the REAL registered handler answering the object, the walk, a real folder
// import into a base — is `scripts/probe-knowledge-base.mjs` section ⑩. What
// is asserted here is the wiring itself: which layer OWNS the shape (the
// service — nobody may re-wrap it), and that the renderer both destructures
// that shape and reports failures instead of dying in silence.
// Non-vacuity for every assertion is noted inline (what breaks when it goes).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

const SHAPE = '{ fileCount: number; filePaths: string[] }'

describe('scan-folder: the service owns the shape', () => {
  it('svcScanFolder answers what the bridge declares, not string[]', () => {
    const svc = read('src/main/services/knowledge-queries.ts')
    // Pre-fix this read `Promise<string[]>` and `return collectSupportedFiles(...)`.
    expect(svc).toMatch(/export async function svcScanFolder\(folderPath: string\): Promise<\{ fileCount: number; filePaths: string\[\] \}>/)
    expect(svc).toMatch(/return \{ fileCount: filePaths\.length, filePaths \}/)
    expect(svc).not.toMatch(/svcScanFolder[\s\S]{0,200}return collectSupportedFiles/)
  })

  it('the IPC handler passes that answer through untouched', () => {
    const handler = read('src/main/ipc/knowledge.handler.ts')
    // A second wrapper computing its own count is how the IPC and the agent
    // host drifted in the first place — the service is the one shaper.
    expect(handler).toMatch(/IPC_CHANNELS\.KNOWLEDGE_SCAN_FOLDER, withRawResponse\(async \(folderPath: string\) => svcScanFolder\(folderPath\)\)/)
    expect(handler).not.toMatch(/KNOWLEDGE_SCAN_FOLDER[\s\S]{0,200}fileCount/)
  })

  it('the agent host passes it through too (no second wrapper)', () => {
    const host = read('src/main/agent/main-host.ts')
    // It used to wrap (`filePaths.length` over the old array) while the IPC
    // did not — that asymmetry hid the break from the hosted path.
    expect(host).toMatch(/knowledgeScanFolder: async \(folderPath\) => kq\.svcScanFolder\(folderPath\),/)
    expect(host).not.toMatch(/knowledgeScanFolder[\s\S]{0,200}filePaths\.length/)
  })
})

describe('scan-folder: the renderer consumes that shape and never fails silently', () => {
  it('the preload method declares the object shape', () => {
    expect(read('src/preload/index.ts')).toMatch(
      /knowledgeScanFolder: \(folderPath: string\): Promise<\{ fileCount: number; filePaths: string\[\] \}> =>\s*\n\s*ipcRenderer\.invoke\(IPC_CHANNELS\.KNOWLEDGE_SCAN_FOLDER, folderPath\)/
    )
  })

  it('the bridge type declares it and KnowledgeManager mirrors it', () => {
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(`knowledgeScanFolder: (folderPath: string) => Promise<${SHAPE}>`)
    expect(read('src/renderer/src/knowledge/KnowledgeManager.ts')).toMatch(`async scanFolder(folderPath: string): Promise<${SHAPE}>`)
  })

  it('handleAddFolder destructures { fileCount, filePaths } and guards the empty scan', () => {
    const panel = read('src/renderer/src/components/knowledge/KnowledgePanel.tsx')
    // Destructuring an array gives undefined for both — fileCount === 0 is what
    // turns "0 files" into the 「文件夹中没有可导入的文件」 toast.
    expect(panel).toMatch(/const \{ fileCount, filePaths \} = await knowledgeManager\.scanFolder\(folderPath\)/)
    expect(panel).toMatch(/if \(fileCount === 0\) \{/)
  })

  it('the scan/confirm path is caught and reported (the 「点了没反应」 half)', () => {
    const panel = read('src/renderer/src/components/knowledge/KnowledgePanel.tsx')
    const fn = panel.slice(panel.indexOf('const handleAddFolder'), panel.indexOf('const handleAddUrl'))
    expect(fn).toMatch(/catch \(err\) \{/)
    expect(fn).toMatch(/notify\.error\(/)
    // The dialog must not be able to fire while the await above it throws.
    expect(fn).toMatch(/try \{[\s\S]*scanFolder[\s\S]*Modal\.confirm/)
  })
})
