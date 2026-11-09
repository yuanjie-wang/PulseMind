// ── 工作流批量运行模态（P2 任务共享内核）──
// 轻量独立组件，刻意不碰 BatchRunModal（它的 wiring 钉太密）：复用
// routineCsvPreview 的映射预览（generic：filePath + params 形状，inputs 直接
// 喂入）+ pipelineBatchRun/pipelineBatchStop。一行 = 一次实例，串行 FIFO
// （无并发/超时选择——gitCheckpoint 撞仓裁定，见 batch-feeder）。

import React, { useEffect, useState } from 'react'
import { Modal, Tag } from 'antd'
import { useTranslation } from '../../i18n/useTranslation'
import type { WorkflowDefinition } from '../../../../shared/workflow/types'

export function WorkflowBatchModal({ workflow, open, onClose, onStarted }: {
  workflow: WorkflowDefinition | null
  open: boolean
  onClose: () => void
  onStarted: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<{ csvName: string; headers: string[]; previewRows: string[][]; totalRows: number; matched: string[]; unmatched: string[]; missingRequired: string[]; overRowLimit: boolean } | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [csvPath, setCsvPath] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)

  // 每次打开按当前定义重拉预览（文件是唯一真源，routine 批量同款纪律）。
  useEffect(() => {
    if (!open || !workflow) return
    setCsvPath(workflow.batch?.csvPath?.trim() || undefined)
    setError(undefined)
    setPreview(null)
    const csv = workflow.batch?.csvPath?.trim()
    if (!csv) {
      setError(t('workflow.batchNoCsv'))
      return
    }
    void (async () => {
      try {
        const res = await window.electronAPI.routineCsvPreview(csv, workflow.inputs)
        if (res.ok && res.preview) {
          setPreview({
            csvName: res.preview.csvName,
            headers: res.preview.headers,
            previewRows: res.preview.previewRows,
            totalRows: res.preview.totalRows,
            matched: res.preview.analysis.matchedParams,
            unmatched: res.preview.analysis.unmatchedHeaders,
            missingRequired: res.preview.analysis.missingRequiredHeaders,
            overRowLimit: res.preview.overRowLimit,
          })
        } else {
          setError(res.error ?? t('common.error'))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [open, workflow, t])

  const blocked = !preview || preview.missingRequired.length > 0 || preview.overRowLimit || preview.totalRows === 0

  const start = async (): Promise<void> => {
    if (!workflow) return
    setStarting(true)
    try {
      await window.electronAPI.pipelineBatchRun({ workflowId: workflow.id, csvPath })
      onStarted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={`${t('workflow.batchRun')} · ${workflow?.name ?? ''}`}
      okText={t('workflow.batchRun')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: blocked, loading: starting }}
      onOk={() => void start()}
      onCancel={onClose}
      width={640}
    >
      {error && <div style={{ color: 'var(--pm-error, #cf1322)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {preview && (
        <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag>{preview.csvName}</Tag>
            <span style={{ color: 'var(--pm-text-muted)' }}>
              {t('workflow.batchRows', { count: preview.totalRows })} · {t('workflow.batchCost')}
            </span>
          </div>
          {preview.missingRequired.length > 0 && (
            <div style={{ color: 'var(--pm-error, #cf1322)' }}>
              {t('workflow.batchMissingCols')}：{preview.missingRequired.join('、')}
            </div>
          )}
          {preview.overRowLimit && <div style={{ color: 'var(--pm-error, #cf1322)' }}>{t('workflow.batchOverLimit')}</div>}
          <div style={{ color: 'var(--pm-text-muted)' }}>
            {t('workflow.batchMatched')}：{preview.matched.length > 0 ? preview.matched.join('、') : '—'}
            {preview.unmatched.length > 0 && ` · ${t('workflow.batchUnmatched')}：${preview.unmatched.join('、')}`}
          </div>
          <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--pm-border-hairline)', borderRadius: 8 }}>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding: '4px 8px', textAlign: 'left', color: 'var(--pm-text-quiet)' }}>#</th>
                  {preview.headers.map((h) => (
                    <th key={h} style={{ padding: '4px 8px', textAlign: 'left', color: preview.matched.includes(h) ? 'var(--pm-success, #52c41a)' : 'var(--pm-text-quiet)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.previewRows.map((row, i) => (
                  <tr key={i}>
                    <td style={{ padding: '4px 8px', color: 'var(--pm-text-quiet)' }}>{i + 1}</td>
                    {row.map((cell, j) => (
                      <td key={j} style={{ padding: '4px 8px', color: 'var(--pm-text-strong)' }}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  )
}
