import { beforeEach, describe, expect, it } from 'vitest'
import {
  detectEol,
  applyEol,
  stripBom,
  restoreBom,
  makeDraftFromDisk,
  isDirty,
  conflictDecision,
  serializeDraft,
  isEditableSize,
  MAX_EDITABLE_BYTES,
} from '../src/renderer/src/stores/preview-edit'
import { usePreviewPaneStore } from '../src/renderer/src/stores/previewPaneStore'

/** PLAN-preview-edit T1：EOL/BOM 往返、dirty 判定、冲突三分支、store 草稿
 *  生命周期（含关标签清理）。非空验证（计划要求）：删掉 applyEol 的 CRLF
 *  分支，`saves with the original CRLF line endings` 一条立刻红。 */

describe('EOL / BOM round trip', () => {
  it('detects CRLF vs LF', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n')
    expect(detectEol('a\nb')).toBe('\n')
    expect(detectEol('ab')).toBe('\n')
  })

  it('applyEol normalizes both ways', () => {
    expect(applyEol('a\r\nb\r\n', '\n')).toBe('a\nb\n')
    expect(applyEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
  })

  it('saves with the original CRLF line endings', () => {
    const disk = '\uFEFFline1\r\nline2\r\n'
    const draft = makeDraftFromDisk(disk)
    draft.content = 'line1 edited\nline2\n'
    expect(serializeDraft(draft)).toBe('\uFEFFline1 edited\r\nline2\r\n')
  })

  it('strips and restores a BOM', () => {
    const { text, hadBom } = stripBom('\uFEFFx')
    expect(hadBom).toBe(true)
    expect(text).toBe('x')
    expect(restoreBom(text, hadBom)).toBe('\uFEFFx')
    expect(restoreBom('y', false)).toBe('y')
  })

  it('EOL/BOM alone never make a clean file dirty', () => {
    const draft = makeDraftFromDisk('\uFEFFa\r\nb\r\n')
    expect(isDirty(draft)).toBe(false)
    draft.content = 'a\nb\n' // what the textarea would hand back
    expect(isDirty(draft)).toBe(false)
    draft.content = 'a changed\nb\n'
    expect(isDirty(draft)).toBe(true)
  })
})

describe('conflictDecision (D7)', () => {
  it('clean draft → silent refresh', () => {
    expect(conflictDecision(false, 'new disk', 'old')).toBe('silent-refresh')
  })

  it('dirty + disk moved off baseline → conflict', () => {
    expect(conflictDecision(true, 'agent text', 'my baseline')).toBe('conflict')
  })

  it('dirty + disk back at baseline → same (no banner)', () => {
    expect(conflictDecision(true, 'my baseline', 'my baseline')).toBe('same')
  })

  it('compares normalized: a CRLF rewrite at the same content is not a conflict', () => {
    expect(conflictDecision(true, 'my baseline\r\n', 'my baseline\n')).toBe('same')
  })
})

describe('size gate (D8)', () => {
  it('1MB is the edit ceiling, preview is unaffected by it', () => {
    expect(isEditableSize(MAX_EDITABLE_BYTES)).toBe(true)
    expect(isEditableSize(MAX_EDITABLE_BYTES + 1)).toBe(false)
  })
})

describe('store draft lifecycle (D4)', () => {
  const conv = 'conv_preview_edit'
  const path = '/tmp/w/a.md'
  const draft = () => makeDraftFromDisk('# hello\n')

  beforeEach(() => {
    usePreviewPaneStore.setState({
      tabsByConversation: {},
      activeByConversation: {},
      reloadTicks: {},
      drafts: {},
      previewModes: {},
      externalChanges: {},
    })
  })

  it('setDraft survives store reads (the remount problem, why it lives here)', () => {
    const s = usePreviewPaneStore.getState()
    s.setDraft(path, draft())
    expect(usePreviewPaneStore.getState().drafts[path]?.baseline).toBe('# hello\n')
    usePreviewPaneStore.getState().setPreviewMode(path, 'source')
    expect(usePreviewPaneStore.getState().previewModes[path]).toBe('source')
  })

  it('closeTab drops the tab’s draft, edit mode and external-change mark', () => {
    const s = usePreviewPaneStore.getState()
    s.openFile(conv, path)
    usePreviewPaneStore.getState().setDraft(path, draft())
    usePreviewPaneStore.getState().setPreviewMode(path, 'source')
    usePreviewPaneStore.getState().markExternalChange(path)

    usePreviewPaneStore.getState().closeTab(conv, path)
    const after = usePreviewPaneStore.getState()
    expect(after.drafts[path]).toBeUndefined()
    expect(after.previewModes[path]).toBeUndefined()
    expect(after.externalChanges[path]).toBeUndefined()
  })

  it('forgetConversation drops every tab’s edit state with the tabs', () => {
    const s = usePreviewPaneStore.getState()
    s.openFile(conv, '/tmp/w/a.md')
    s.openFile(conv, '/tmp/w/b.md')
    usePreviewPaneStore.getState().setDraft('/tmp/w/a.md', draft())
    usePreviewPaneStore.getState().setPreviewMode('/tmp/w/b.md', 'source')

    usePreviewPaneStore.getState().forgetConversation(conv)
    const after = usePreviewPaneStore.getState()
    expect(Object.keys(after.drafts)).toEqual([])
    expect(Object.keys(after.previewModes)).toEqual([])
  })
})
