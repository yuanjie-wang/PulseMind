// ── 预览动作菜单（2026-10-31 抽共享）──
// 工作台地址栏的 ⋯ 更多菜单与沉浸窗口页签条右端的 ⋯（2026-10-31 用户裁定
// 「沉浸模式去掉地址栏那一行」）说同一份动作：编辑/查看、元素编辑（html）、
// 保存、刷新。动作全部对着「屏幕上的活动文件」（地址栏的老语义），存储读取
// 与回退行为同源——两个消费面共用一个构造函数，语义不再分叉。

import { message } from 'antd'
import type { MenuProps } from 'antd'
import { Check, Eye, FileDiff, PenLine, RotateCw, Save, Search } from 'lucide-react'
import { detectFileKind } from '../../../../shared/preview/file-kind'
import { isDirty } from '../../stores/preview-edit'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../../stores/previewPaneStore'
import { openPreviewSearchPanel, parkPreviewPanelOpen } from '../preview/preview-cm-seam'
import { useTranslation } from '../../i18n/useTranslation'

export function usePreviewFileActions(conversationId: string | undefined): MenuProps['items'] {
  const { t } = useTranslation()
  const key = conversationId ?? DRAFT_CONVERSATION_KEY
  const activePath = usePreviewPaneStore((s) => s.activeByConversation[key] ?? null)
  const drafts = usePreviewPaneStore((s) => s.drafts)
  const previewModes = usePreviewPaneStore((s) => s.previewModes)
  const oversized = usePreviewPaneStore((s) => s.oversized)
  const diffVisible = usePreviewPaneStore((s) => s.diffVisible)
  const agentDiffBases = usePreviewPaneStore((s) => s.agentDiffBases)

  // The menu targets the file ON SCREEN (the address bar's old ruling).
  const activeKind = activePath ? detectFileKind(activePath) : null
  const editableKind = activeKind === 'markdown' || activeKind === 'text' || activeKind === 'csv' || activeKind === 'html'
  const mode = activePath ? (previewModes[activePath] ?? 'view') : 'view'
  const editOn = mode === 'source'
  const elementOn = mode === 'element' && activeKind === 'html'
  const dirty = !!activePath && !!drafts[activePath] && isDirty(drafts[activePath])
  const oversizedActive = !!activePath && !!oversized[activePath]
  const editDisabled = !activePath || !editableKind || oversizedActive
  // Agent-change review diff toggle (2026-11-01 pivot): only meaningful when
  // a resolved base exists (an agent change is under review). ABSENT
  // diffVisible = on (auto-show), mirroring PreviewContent's read.
  const diffOn = !!activePath && (diffVisible[activePath] ?? true)
  const diffDisabled = !activePath || !agentDiffBases[activePath]

  const toggleSource = () => {
    if (!activePath || editDisabled) return
    usePreviewPaneStore.getState().setPreviewMode(activePath, editOn ? 'view' : 'source')
  }

  const toggleDiff = () => {
    if (!activePath || diffDisabled) return
    usePreviewPaneStore.getState().setDiffVisible(activePath, !diffOn)
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

  // 查找替换（2026-11-02 合并入口）：单一入口开「查找+替换」面板，⌘F 是
  // 同一面板的键盘路径。面板的替换行由包按 readOnly 决定——只有 source 态
  // 才渲染——所以入口在 view 态先翻 source 并 park 意图（flip effect 在
  // readOnly 重配完成后开面板，替换行才在场）；CM 只在 text 的两态与其余
  // 可编辑类的 source 态挂载，翻 source 同时保证文本层在场。纯阅读搜索走
  // ⌘F（view 态面板只读、只搜不改），替换走本入口（翻转可见、走草稿/保
  // 存管线）。
  const openSearchReplace = () => {
    if (!activePath || editDisabled) return
    if (!editOn) {
      parkPreviewPanelOpen()
      usePreviewPaneStore.getState().setPreviewMode(activePath, 'source')
      return
    }
    openPreviewSearchPanel()
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
    {
      key: 'diff',
      icon: <FileDiff size={13} />,
      label: diffOn ? t('previewPane.diffHide') : t('previewPane.diffShow'),
      disabled: diffDisabled,
      onClick: toggleDiff,
    },
    {
      key: 'searchReplace',
      icon: <Search size={13} />,
      label: t('previewPane.searchReplace'),
      disabled: editDisabled,
      onClick: openSearchReplace,
    },
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
