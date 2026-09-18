// @vitest-environment jsdom
// PLAN-office-export M2 — the preview-pane half of the export wiring. The
// renderer store chain behind usePreviewPaneSync needs a `window`, so this
// file runs under jsdom (the unit under test is the PURE ingest function).
import { describe, expect, it } from 'vitest'
import { ingestAgentEvent } from '../src/renderer/src/hooks/usePreviewPaneSync'
import { tierOfTool } from '../src/renderer/src/agent/engine/tool-tiers'
import { FILE_WRITER_TOOLS } from '../src/renderer/src/components/chat/deliverables'

describe('export_document renderer wiring', () => {
  it('approval tier is write (WRITE_TIER_TOOLS)', () => {
    expect(tierOfTool('export_document')).toBe('write')
  })

  it('deliverables: export_document is a FILE_WRITER_TOOL (its result names a path)', () => {
    expect(FILE_WRITER_TOOLS.has('export_document')).toBe(true)
  })

  it('ingestAgentEvent fires a FORCE pane event when the export completes', () => {
    const known = new Map<string, { name: string; path: string }>()
    const start = ingestAgentEvent(known, {
      type: 'tool_start', toolUseId: 'u1', name: 'export_document',
      input: { file_path: '/ws/报告.xlsx' },
    } as never)
    expect(start).toEqual([])
    const fired = ingestAgentEvent(known, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 'u1', status: 'completed', exitCode: 0 }],
    } as never)
    expect(fired).toHaveLength(1)
    expect(fired[0].tool).toBe('export_document')
    expect(fired[0].force).toBe(true)
    expect(fired[0].path).toBe('/ws/报告.xlsx')
  })

  it('a failed export fires nothing (exitCode 1, like write/edit)', () => {
    const known = new Map<string, { name: string; path: string }>()
    ingestAgentEvent(known, {
      type: 'tool_start', toolUseId: 'u2', name: 'export_document',
      input: { file_path: '/ws/bad.xlsx' },
    } as never)
    const fired = ingestAgentEvent(known, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 'u2', status: 'completed', exitCode: 1 }],
    } as never)
    expect(fired).toEqual([])
  })
})
