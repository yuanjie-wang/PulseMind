// ── Preview pane body (PLAN-preview-pane §设计3; PLAN-workbench W1;
//    PLAN-preview-edit T2/T3) ──
// The preview area of the merged 工作区 view: the active file's per-kind
// content, or the empty hint. There is no tab strip and no toolbar here any
// more (2026-10-25, 用户裁定「去掉预览区的顶部文件页签」) — the file's path
// lives in the address bar above (WorkspacePane) and 编辑/保存/刷新 ride its
// 更多 menu, which drives the same store fields this component reads.
// Editing state (drafts / edit modes / dirty dots) lives in previewPaneStore;
// the save path is owned HERE so ⌘S inside the editor and the menu item share
// one write+refresh sequence (they meet at the `pulsemind-preview-save`
// event).

import React, { useEffect } from 'react'
import { message } from 'antd'
import { FileText } from 'lucide-react'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { useHtmlEditStore } from '../../stores/htmlEditStore'
import { serializeDraft } from '../../stores/preview-edit'
import { PreviewContent } from './PreviewContent'

interface Props {
  conversationId: string | undefined
}

export function PreviewPane({ conversationId }: Props): React.ReactElement {
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const reloadTicks = usePreviewPaneStore((s) => s.reloadTicks)
  const previewModes = usePreviewPaneStore((s) => s.previewModes)

  // ── The one save path (D5): draft → serialize (EOL/BOM restored) →
  // writeFile → adopt as new baseline → bumpReload. The html iframe's
  // key={reloadTick} remounts it, so no special-casing there. A source-mode
  // save also drops any element-edit session — the session's file text no
  // longer matches the disk, and it would re-initialize from the new text
  // on the next entry. ──
  useEffect(() => {
    const saveDraft = async (path: string) => {
      const store = usePreviewPaneStore.getState()
      const entry = store.drafts[path]
      if (!entry) return
      try {
        // expectContent = the disk text EXACTLY as the draft last saw it — the
        // normalized `baseline` never equals a CRLF/BOM disk file, which used to
        // refuse every save of such files with "文件已被外部修改" (H8). The
        // serialized content below restores EOL/BOM, so the written bytes and
        // this gate compare against the same shape. If the disk moved under the
        // draft, the main side refuses the overwrite and bumpReload re-reads.
        const serialized = serializeDraft(entry)
        const res = await window.electronAPI.writeFile({
          filePath: path,
          content: serialized,
          expectContent: entry.diskText ?? entry.baseline,
        })
        if (res && res.success === false) {
          void message.error(res.error || 'Save failed')
          store.bumpReload(path)
          return
        }
        store.setDraft(path, { ...entry, baseline: entry.content, diskText: serialized })
        store.clearExternalChange(path)
        useHtmlEditStore.getState().forgetFile(path)
        store.bumpReload(path)
      } catch (err) {
        void message.error(err instanceof Error ? err.message : 'Save failed')
      }
    }
    const onSaveRequest = (e: Event) => {
      const path = (e as CustomEvent<string>).detail
      void saveDraft(path)
    }
    window.addEventListener('pulsemind-preview-save', onSaveRequest)
    return () => window.removeEventListener('pulsemind-preview-save', onSaveRequest)
  }, [])

  if (!activePath) {
    return (
      <div style={{ padding: 24, fontSize: 12, color: 'var(--pm-text-muted)', textAlign: 'center' }}>
        {/* The decorative icon keeps its literal grey: a hue-neutral ink that
            reads on both grounds, like the status dots below. */}
        <FileText size={20} style={{ display: 'block', margin: '0 auto 8px', color: '#d9d9d9' }} />
        在左侧目录树中点击文件预览
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--pm-text-faint)' }}>AI 写入的文件也会在这里实时打开</div>
      </div>
    )
  }

  // The editor and the html iframe need a non-scrolling shell (they scroll
  // internally); every view kind wants the page scroll back.
  const mode = previewModes[activePath] ?? 'view'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: mode === 'view' ? 'auto' : 'hidden' }}>
        <PreviewContent key={activePath} path={activePath} reloadTick={reloadTicks[activePath] ?? 0} />
      </div>
    </div>
  )
}
