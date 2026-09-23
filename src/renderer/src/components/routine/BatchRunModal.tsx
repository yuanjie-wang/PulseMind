// ── Batch run dialog (例行任务 · 批量运行, PLAN-routine-batch M6) ──
// The one entry point for starting a batch by hand, shared by the card grid
// and the run workspace. Before the click it shows exactly what will happen:
// the file, the header↔param mapping verdict, the first rows, and — above the
// start button, because it is a bill the user signs — how many independent
// conversations the run will create. Blocking problems (missing required
// column, over the row cap, unreadable file) disable 开始 and say why.

import React, { useEffect, useRef, useState } from 'react'
import { Modal, Select, Tag } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import { notify } from '../../utils/notify'
import { analyzeCsvBatch, BATCH_TIMEOUT_MINUTE_OPTIONS, DEFAULT_BATCH_CONCURRENCY, DEFAULT_BATCH_TIMEOUT_MINUTES, MAX_BATCH_CONCURRENCY, MAX_BATCH_ROWS } from '../../../../shared/routine/batch'
import type { CsvPreview } from '../../../../shared/routine/batch'
import type { Routine } from '../../../../shared/types/routine'

export function BatchRunModal({ routine, open, onClose, onStarted }: {
  routine: Routine | null
  open: boolean
  onClose: () => void
  onStarted: (routine: Routine) => void
}): React.ReactElement {
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // Per-run overrides (L2): concurrency and the per-row 单次超时 default to
  // the task's saved values on every open, ride the start click, and are
  // never written back to the config — the saved values in the editor stay
  // the default for next time.
  const [concurrency, setConcurrency] = useState(DEFAULT_BATCH_CONCURRENCY)
  const [timeoutMinutes, setTimeoutMinutes] = useState(DEFAULT_BATCH_TIMEOUT_MINUTES)
  const fetchNonceRef = useRef(0)

  // (Re)read when the dialog finishes opening for a routine — the same event
  // pattern RoutineRunModal uses, so reopening never shows the previous
  // file's verdict and the reset never runs mid-render.
  const afterOpenChange = (next: boolean): void => {
    if (!next || !routine) return
    const nonce = ++fetchNonceRef.current
    setPreview(null)
    setError(null)
    setConcurrency(routine.batch?.concurrency ?? DEFAULT_BATCH_CONCURRENCY)
    setTimeoutMinutes(routine.batch?.timeoutMinutes ?? DEFAULT_BATCH_TIMEOUT_MINUTES)
    void window.electronAPI.routineCsvPreview(routine.batch!.csvPath, routine.params)
      .then((res) => {
        if (fetchNonceRef.current !== nonce) return
        if (res.ok && res.preview) setPreview(res.preview)
        else setError(res.error ?? '读取批量数据文件失败')
      })
      .catch(() => { if (fetchNonceRef.current === nonce) setError('读取批量数据文件失败') })
  }

  const csvPath = routine?.batch?.csvPath ?? ''
  const analysis = preview ? analyzeCsvBatch(preview.headers, [], routine?.params) : null
  // Blocking = the runner would refuse the start anyway; say it here first.
  const blocked =
    error != null ||
    (analysis?.missingRequiredHeaders.length ?? 0) > 0 ||
    (preview?.overRowLimit ?? false)

  const start = (): void => {
    if (!routine || blocked) return
    setStarting(true)
    void window.electronAPI.routineBatchRun(routine.id, concurrency, timeoutMinutes)
      .then(() => {
        notify.success(`批量任务已启动：${routine.name}`)
        onStarted(routine)
      })
      .catch((err) => notify.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setStarting(false))
  }

  const shownHeaders = preview?.headers.slice(0, 6) ?? []
  return (
    <Modal
      title={routine ? `批量运行「${routine.name}」` : ''}
      open={open}
      onCancel={onClose}
      onOk={start}
      afterOpenChange={afterOpenChange}
      confirmLoading={starting}
      width={520}
      cancelText="取消"
      okText="开始"
      okButtonProps={{ disabled: !preview || blocked, danger: true }}
      focusTriggerAfterClose={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
        {csvPath && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <Tag style={{ marginInlineEnd: 0, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} icon={<FileTextOutlined />}>
              {csvPath}
            </Tag>
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: '#cf1322' }}>{error}</div>}
        {preview && analysis && (
          <>
            <div style={{ fontSize: 12, color: '#999' }}>数据文件的每一行都会用独立会话执行一次任务</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Select
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                value={concurrency}
                onChange={setConcurrency}
                options={Array.from({ length: MAX_BATCH_CONCURRENCY }, (_, i) => ({ value: i + 1, label: `同时执行 ${i + 1} 行` }))}
                data-batch-concurrency
              />
              <Select
                size="small"
                style={{ flex: 1, minWidth: 0 }}
                value={timeoutMinutes}
                onChange={setTimeoutMinutes}
                options={BATCH_TIMEOUT_MINUTE_OPTIONS.map((m) => ({ value: m, label: `单次超时 ${m} 分钟` }))}
                data-batch-timeout
              />
            </div>
            <div style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 8, overflow: 'hidden' }} data-batch-run-preview>
              <div style={{ display: 'flex', background: 'var(--pm-fill)' }}>
                {shownHeaders.map((h) => {
                  const param = routine?.params?.find((p) => p.key === h)
                  return (
                    <div key={h} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {param ? <span style={{ color: '#389e0d' }}>{h} · {param.label || param.key}</span> : <span style={{ color: '#999' }}>{h} · 未使用</span>}
                    </div>
                  )
                })}
                {preview.headers.length > shownHeaders.length && (
                  <div style={{ padding: '6px 8px', fontSize: 11, color: '#999', flexShrink: 0 }}>+{preview.headers.length - shownHeaders.length} 列</div>
                )}
              </div>
              {preview.previewRows.map((row, i) => (
                <div key={i} style={{ display: 'flex', borderTop: '1px solid var(--pm-border-faint)' }}>
                  {shownHeaders.map((_h, j) => (
                    <div key={j} style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 12, color: 'var(--pm-text-quiet)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row[j] ?? ''}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#999' }}>共 {preview.totalRows} 行，预览前 {preview.previewRows.length} 行。</div>
            {analysis.missingRequiredHeaders.length > 0 && (
              <div style={{ fontSize: 12, color: '#cf1322' }}>缺少必填参数的列：{analysis.missingRequiredHeaders.join('、')}</div>
            )}
            {analysis.unmatchedHeaders.length > 0 && (
              <div style={{ fontSize: 12, color: '#999' }}>未匹配参数的列（将忽略）：{analysis.unmatchedHeaders.join('、')}</div>
            )}
            {preview.overRowLimit && (
              <div style={{ fontSize: 12, color: '#cf1322' }}>共 {preview.totalRows} 行，超过单批 {MAX_BATCH_ROWS} 行上限，请拆分文件</div>
            )}
            {/* The cost note is the last line of the body — directly above the
                footer's 开始, where the user signs it. The count deliberately
                does NOT ride the ok button's label: a paired footer must stay
                a matched pair (取消/开始 both 64px), and a parenthetical
                sentence stretched the primary to 142px against the 64px
                cancel — the size mismatch this replaced. */}
            <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', fontWeight: 500 }} data-batch-cost-note>
              将创建 {preview.totalRows} 个独立会话
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** Shared 批量运行 entry (mirrors useRoutineRunNow): owns the dialog state and
 *  the started notification so every surface behaves identically. */
export function useRoutineBatchRun(onStarted?: (routine: Routine) => void): {
  runBatch: (routine: Routine) => void
  modal: React.ReactElement
} {
  const [pending, setPending] = useState<Routine | null>(null)
  const [open, setOpen] = useState(false)
  const onStartedRef = useRef(onStarted)
  useEffect(() => { onStartedRef.current = onStarted })

  const runBatch = (routine: Routine): void => {
    if (!routine.batch?.csvPath) {
      notify.error('该任务没有配置批量数据文件')
      return
    }
    setPending(routine)
    setOpen(true)
  }

  const modal = (
    <BatchRunModal
      routine={pending}
      open={open}
      onClose={() => setOpen(false)}
      onStarted={(routine) => {
        setOpen(false)
        onStartedRef.current?.(routine)
      }}
    />
  )
  return { runBatch, modal }
}
