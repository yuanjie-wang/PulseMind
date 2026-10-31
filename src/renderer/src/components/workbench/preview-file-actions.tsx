// ── 预览动作菜单（2026-10-31 抽共享）──
// 工作台地址栏的 ⋯ 更多菜单与沉浸窗口页签条右端的 ⋯（2026-10-31 用户裁定
// 「沉浸模式去掉地址栏那一行」）说同一份动作：编辑/查看、元素编辑（html）、
// 保存、刷新。动作全部对着「屏幕上的活动文件」（地址栏的老语义），存储读取
// 与回退行为同源——两个消费面共用一个构造函数，语义不再分叉。

import { message } from 'antd'
import type { MenuProps } from 'antd'
import { Check, Eye, PenLine, RotateCw, Save } from 'lucide-react'
import { detectFileKind } from '../../../../shared/preview/file-kind'
import { isDirty } from '../../stores/preview-edit'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useTranslation } from '../../i18n/useTranslation'

export function usePreviewFileActions(conversationId: string | undefined): MenuProps['items'] {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const drafts = usePreviewPaneStore((s) => s.drafts)
  const previewModes = usePreviewPaneStore((s) => s.previewModes)
  const oversized = usePreviewPaneStore((s) => s.oversized)

  // The menu targets the file ON SCREEN (the address bar's old ruling).
  const activeKind = activePath ? detectFileKind(activePath) : null
  const editableKind = activeKind === 'markdown' || activeKind === 'text' || activeKind === 'csv' || activeKind === 'html'
  const mode = activePath ? (previewModes[activePath] ?? 'view') : 'view'
  const editOn = mode === 'source'
  const elementOn = mode === 'element' && activeKind === 'html'
  const dirty = !!activePath && !!drafts[activePath] && isDirty(drafts[activePath])
  const oversizedActive = !!activePath && !!oversized[activePath]
  const editDisabled = !activePath || !editableKind || oversizedActive

  const toggleSource = () => {
    if (!activePath || editDisabled) return
    usePreviewPaneStore.getState().setPreviewMode(activePath, editOn ? 'view' : 'source')
  }

  const toggleElement = () => {
    if (!activePath || activeKind !== 'html') return
    if (oversizedActive) {
      void message.info(t('previewPane.tooLarge'))
      return
    }
    usePreviewPaneStore.getState().setPreviewMode(activePath, elementOn ? 'view' : 'element')
  }

  const saveActive = () => {
    if (!activePath) return
    // The one save seam: PreviewPane owns the write sequence and both ⌘S in
    // the editor and this menu item meet at the event.
    window.dispatchEvent(new CustomEvent('pulsemind-preview-save', { detail: activePath }))
  }

  return [
    {
      key: 'edit',
      icon: editOn ? <Eye size={13} /> : <PenLine size={13} />,
      label: editDisabled ? t('previewPane.editNotAvailable') : editOn ? t('previewPane.view') : t('previewPane.edit'),
      disabled: editDisabled,
      onClick: toggleSource,
    },
    ...(activeKind === 'html'
      ? [
          {
            key: 'element',
            icon: <Check size={13} style={{ visibility: elementOn ? 'visible' : 'hidden' }} />,
            label: t('htmlEdit.modeToggle'),
            onClick: toggleElement,
          },
        ]
      : []),
    { type: 'divider' as const },
    {
      key: 'save',
      icon: <Save size={13} />,
      label: t('previewPane.save'),
      disabled: !dirty,
      onClick: saveActive,
    },
    {
      key: 'refresh',
      icon: <RotateCw size={12} />,
      label: t('previewPane.refresh'),
      disabled: !activePath,
      onClick: () => activePath && usePreviewPaneStore.getState().bumpReload(activePath),
    },
  ]
}
