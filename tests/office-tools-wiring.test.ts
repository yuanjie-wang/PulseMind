// PLAN-office-editing T11/T15 wiring half — source scans (vitest here is
// node-env; the hooks/IPC surface cannot mount) in the shape of
// ipc-registration / pending-approval tests. Non-vacuity: each scan asserts
// content whose removal is exactly what would break the feature silently.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('office tools five-point wiring', () => {
  const channels = read('src/shared/ipc-channels.ts')
  const handler = read('src/main/ipc/file-ops.handler.ts')
  const preload = read('src/preload/index.ts')
  const bridge = read('src/shared/types/electron-bridge.ts')
  const hostTypes = read('src/renderer/src/agent/host/types.ts')
  const mainHost = read('src/main/agent/main-host.ts')

  it('each channel is registered main-side, exposed via preload, and typed on the bridge', () => {
    for (const [channel, method] of [
      ['UTIL_EDIT_DOCX', 'editDocx'],
      ['UTIL_EDIT_XLSX', 'editXlsx'],
      ['UTIL_SEARCH_OFFICE', 'searchOffice'],
    ] as const) {
      expect(channels).toContain(`${channel}: 'util:`)
      expect(handler).toContain(`IPC_CHANNELS.${channel}`)
      expect(preload).toContain(`${method}: (input`)
      expect(bridge).toContain(`${method}: (input`)
      expect(hostTypes).toContain(`'${method}'`)
      expect(mainHost).toContain(`${method}: async`)
    }
  })

  it('the services stay behind the standard write sequence', () => {
    const docx = read('src/main/services/docx-ops.ts')
    const xlsx = read('src/main/services/xlsx-ops.ts')
    for (const [name, source] of [
      ['docx-ops', docx],
      ['xlsx-ops', xlsx],
    ] as const) {
      expect(source, name).toContain('guardFsTarget(')
      expect(source, name).toContain('withPathLock(')
      expect(source, name).toContain('backupOfficeOriginal(')
      // atomic tmp+rename, not a direct overwrite
      expect(source, name).toContain('pm-tmp')
    }
  })
})

describe('tool surface', () => {
  it('the merged office tool is declared, gated into the write tier, dispatched, and labelled', () => {
    const tools = read('src/renderer/src/tools/built-in-tools.ts')
    const tiers = read('src/renderer/src/agent/engine/tool-tiers.ts')
    const executors = read('src/renderer/src/agent/tool-executors.ts')
    const summary = read('src/renderer/src/components/chat/tool-summary.ts')
    const instructions = read('src/renderer/src/tools/tool-instructions.ts')
    const limits = read('src/renderer/src/agent/engine/engine-constants.ts')
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')

    const name = 'office_edit'
    expect(tools).toContain(`name: '${name}'`)
    expect(tiers).toContain(`'${name}'`) // WRITE_TIER_TOOLS → approval hold
    expect(executors).toContain(`'${name}'`) // execWorkspaceTool case
    expect(summary).toContain(`'${name}'`) // card label family
    expect(instructions).toContain(`${name}: \``) // static instructions (cache contract)
    expect(limits).toContain(`${name}:`) // ops payload cap
    expect(zh).toContain(`${name}: '`) // i18n label zh
    expect(en).toContain(`${name}: '`) // i18n label en
    // The three retired names survive ONLY where hydrated history needs them
    // (deliverables' writer sets + i18n labels) — nowhere as a live tool.
    expect(tools).not.toContain("name: 'docx_edit'")
    expect(tools).not.toContain("name: 'xlsx_edit'")
    expect(tools).not.toContain("name: 'pptx_edit'")
    expect(zh).toContain("docx_edit: '") // old transcripts keep human labels
  })

  it('reading no longer rides the edit tool (office_read owns it)', () => {
    const tools = read('src/renderer/src/tools/built-in-tools.ts')
    // The read ops are gone from office_edit's vocabulary — office_read took
    // them over; a stale {"op":"outline"} gets a migration hint, not a backup.
    expect(tools).toContain("name: 'office_read'")
    const officeEdit = tools.slice(tools.indexOf("name: 'office_edit'"))
    const schema = officeEdit.slice(0, officeEdit.indexOf('instructions:'))
    expect(schema).not.toContain("'outline'")
    expect(schema).not.toContain("'inspect'")
  })

  it('office_search is declared, gated, dispatched, and labelled — with its manual (2026-10-12)', () => {
    const tools = read('src/renderer/src/tools/built-in-tools.ts')
    const tiers = read('src/renderer/src/agent/engine/tool-tiers.ts')
    const executors = read('src/renderer/src/agent/tool-executors.ts')
    const summary = read('src/renderer/src/components/chat/tool-summary.ts')
    const instructions = read('src/renderer/src/tools/tool-instructions.ts')
    const formatter = read('src/renderer/src/agent/office-search-format.ts')
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')

    const name = 'office_search'
    expect(tools).toContain(`name: '${name}'`)
    expect(tiers).toContain(`'${name}'`) // READ_TIER_TOOLS — reads never wait
    expect(executors).toContain(`'${name}'`) // both dispatch surfaces
    expect(summary).toContain(`'${name}'`) // card object row family
    expect(instructions).toContain(`${name}: \``) // static manual (cache contract)
    expect(formatter).toContain(`formatOfficeSearchResult`) // envelope last
    expect(zh).toContain(`${name}: '`)
    expect(en).toContain(`${name}: '`)
  })

  it('the text write tools refuse office binaries (L11)', () => {
    const fileOps = read('src/main/services/file-ops.ts')
    for (const ext of ['.docx', '.xlsx', '.pptx', '.doc', '.xls']) {
      expect(fileOps).toContain(`'${ext}'`)
    }
    expect(fileOps).toContain('officeBinaryReject')
  })

  it('the office preview renders converted markdown with a fallback', () => {
    const preview = read('src/renderer/src/components/preview/PreviewContent.tsx')
    expect(preview).toContain('OfficePreview')
    expect(preview).toContain('convertFileToMarkdown')
    expect(preview).toContain("kind === 'office'")
  })
})
