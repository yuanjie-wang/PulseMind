// ── 分享导入预览模态（PLAN-share-import-export）──
// 预览行（名称/类型/摘要 + 警示行）+ 冲突三选一（创建副本默认/覆盖更新/跳过）
// + 结果反馈。kind 无关——routine 与工作流共用同一模态。提交通道只收
// importToken（消毒 payload 留在主进程）。

import React, { useCallback, useState } from 'react'
import { App as AntdApp, Modal, Radio, Tag } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import type { ShareImportMode, SharePreviewItem } from '../../../../shared/share/types'

interface ShareImportModalProps {
  open: boolean
  importToken: string
  items: SharePreviewItem[]
  /** 预览层透出的解析错误（如「文件来自更新版本」）。 */
  error?: string
  onClose: () => void
}

export function ShareImportModal({ open, importToken, items, error, onClose }: ShareImportModalProps): React.ReactElement {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  /** 每条 item 的分辨率（blocked 条目恒 skip）。 */
  const [modes, setModes] = useState<Record<number, ShareImportMode>>({})
  const [committing, setCommitting] = useState(false)

  const modeOf = (item: SharePreviewItem): ShareImportMode => modes[item.index] ?? (item.blocked ? 'skip' : item.nameConflict ? 'create' : 'create')

  const commit = useCallback(async () => {
    setCommitting(true)
    try {
      const resolutions = items.map((item) => ({ index: item.index, mode: modeOf(item), ...(modeOf(item) === 'overwrite' && item.conflictId ? { targetId: item.conflictId } : {}) }))
      const res = await window.electronAPI.shareImportCommit({ importToken, resolutions })
      const parts = [
        `${t('share.imported')} ${res.imported}`,
        `${t('share.overwritten')} ${res.overwritten}`,
        `${t('share.skipped')} ${res.skipped}`,
      ]
      if (res.failed > 0) parts.push(`${t('share.failed')} ${res.failed}`)
      if (res.failed > 0) message.error(parts.join(' · ') + (res.errors.length ? `\n${res.errors.join('\n')}` : ''))
      else message.success(parts.join(' · '))
      onClose()
    } finally {
      setCommitting(false)
    }
  }, [items, importToken, message, onClose, t])

  const total = items.filter((i) => !i.blocked && modeOf(i) !== 'skip').length

  return (
    <Modal
      open={open}
      title={t('share.importTitle')}
      width={620}
      okText={`${t('share.import')} (${total})`}
      okButtonProps={{ disabled: total === 0, loading: committing }}
      cancelText={t('common.cancel')}
      onOk={() => void commit()}
      onCancel={onClose}
    >
      {error && (
        <div role="alert" style={{ background: 'var(--pm-warn-bg, #fff7e6)', border: '1px solid var(--pm-border)', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: 'var(--pm-error, #cf1322)' }}>
          {error}
        </div>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((item) => (
          <div key={item.index} style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 10, padding: '10px 12px', opacity: item.blocked ? 0.55 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Tag color={item.kind === 'workflow' ? 'geekblue' : 'cyan'}>{item.kind === 'workflow' ? t('share.kindWorkflow') : t('share.kindRoutine')}</Tag>
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
              {item.blocked && <Tag color="error">{t('share.blocked')}</Tag>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', marginTop: 2 }}>{item.summary}</div>
            {item.warnings.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--pm-warn-ink, #d46b08)', marginTop: 4, display: 'grid', gap: 2 }}>
                {item.warnings.map((w, i) => (
                  <span key={i}>⚠ {w}</span>
                ))}
              </div>
            )}
            {item.nameConflict && !item.blocked && (
              <div style={{ marginTop: 6 }}>
                <Radio.Group
                  size="small"
                  value={modeOf(item)}
                  onChange={(e) => setModes((m) => ({ ...m, [item.index]: e.target.value as ShareImportMode }))}
                  options={[
                    { value: 'create', label: t('share.modeCreate') },
                    { value: 'overwrite', label: t('share.modeOverwrite') },
                    { value: 'skip', label: t('share.modeSkip') },
                  ]}
                />
              </div>
            )}
          </div>
        ))}
        {items.length === 0 && !error && <div style={{ fontSize: 12, color: 'var(--pm-text-quiet)' }}>{t('share.noItems')}</div>}
      </div>
    </Modal>
  )
}
