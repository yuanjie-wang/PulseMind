// ── Preview pane body (PLAN-preview-pane §设计3; PLAN-workbench W1) ──
// The workbench's FILE tab content: file tab strip, toolbar (refresh /
// open-in-system / save-as), and the per-kind content dispatcher. Positioning
// and the drag handle belong to WorkbenchPane — this component always fills
// its parent. Pure DOM — no native WebContentsView behind it.

import React from 'react'
import { RotateCw, ExternalLink, Download, X, FileText } from 'lucide-react'
import { usePreviewPaneStore, DRAFT_CONVERSATION_KEY } from '../../stores/previewPaneStore'
import { PreviewContent } from './PreviewContent'
import { useTranslation } from '../../i18n/useTranslation'

const ICON_BUTTON: React.CSSProperties = {
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: '#666',
  flexShrink: 0,
  cursor: 'pointer',
}

interface Props {
  conversationId: string | undefined
}

export function PreviewPane({ conversationId }: Props): React.ReactElement {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const convArg = conversationId ?? null
  const tabs = usePreviewPaneStore((s) => s.tabsByConversation[key])
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const reloadTicks = usePreviewPaneStore((s) => s.reloadTicks)

  if (!tabs || tabs.length === 0) {
    return (
      <div style={{ padding: 24, fontSize: 12, color: '#999', textAlign: 'center' }}>
        <FileText size={20} style={{ display: 'block', margin: '0 auto 8px', color: '#d9d9d9' }} />
        暂无打开的文件
        <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>AI 写入的文件会在这里实时预览</div>
      </div>
    )
  }

  const active = tabs.find((tab) => tab.path === activePath) ?? tabs[tabs.length - 1]
  const store = usePreviewPaneStore.getState()

  const saveAs = async () => {
    try {
      const { filePath, canceled } = await window.electronAPI.showSaveDialog({ defaultName: active.title })
      if (canceled || !filePath) return
      await window.electronAPI.copyFile({ source: active.path, destination: filePath })
    } catch (err) {
      console.warn('[preview-pane] save-as failed:', err)
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      {/* File tab strip (32px) */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 6px 0 12px',
          borderBottom: '1px solid #ececf0',
          background: '#f0f1f4',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, overflow: 'hidden' }}>
          {tabs.map((tab) => (
            <div
              key={tab.path}
              onClick={() => tab.path !== active.path && store.setActive(convArg, tab.path)}
              title={tab.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                maxWidth: 140,
                padding: '3px 8px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                background: tab.path === active.path ? '#fff' : 'transparent',
                boxShadow: tab.path === active.path ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
                color: tab.path === active.path ? '#333' : '#888',
                flexShrink: 0,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.title}</span>
              <X
                size={11}
                onClick={(e) => {
                  e.stopPropagation()
                  store.closeTab(convArg, tab.path)
                }}
                style={{ flexShrink: 0, opacity: 0.6 }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Toolbar row (36px): refresh / path / open-in-system / save-as */}
      <div
        style={{
          height: 36,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 8px',
          borderBottom: '1px solid #ececf0',
          background: '#fff',
        }}
      >
        <div style={{ ...ICON_BUTTON }} onClick={() => store.bumpReload(active.path)} title={t('previewPane.refresh')}>
          <RotateCw size={12} />
        </div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            color: '#999',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
          title={active.path}
        >
          {active.path}
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => void window.electronAPI.openFolder(active.path).catch(() => {})} title={t('previewPane.openInOs')}>
          <ExternalLink size={12} />
        </div>
        <div style={{ ...ICON_BUTTON }} onClick={() => void saveAs()} title={t('previewPane.saveAs')}>
          <Download size={12} />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <PreviewContent key={active.path} path={active.path} reloadTick={reloadTicks[active.path] ?? 0} />
      </div>
    </div>
  )
}
