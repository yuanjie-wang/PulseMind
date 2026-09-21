// ── Routine form view ──
// The fields column of the routine editor page. Presentation only: draft
// state, validation and the assistant-proposal merge live in
// routine-form-model.ts; the page owns the column header (title / 保存), the
// scroll container, saving and the assistant session.
//
// Field treatment follows the expert editor's form (capability center): the
// fields sit directly on the shared gray surface, labels carry the structure on
// their own, and the explanatory text lives in the placeholders.

import React from 'react'
import { Button, Checkbox, Input, InputNumber, Select, Space, Switch, Tag } from 'antd'
import { DeleteOutlined, FileTextOutlined, PlusOutlined } from '@ant-design/icons'
import { checkCron, nextRun } from '../../../../shared/schedule/cron'
import { configToCron, WEEKDAY_LABELS } from '../../utils/schedule-builder'
import type { ScheduleConfig } from '../../utils/schedule-builder'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { analyzeCsvBatch, DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_ROWS, MAX_BATCH_CONCURRENCY } from '../../../../shared/routine/batch'
import type { CsvPreview } from '../../../../shared/routine/batch'
import { useTranslation } from '../../i18n/useTranslation'
import { AppliedPatchBar } from '../form-assist/AppliedPatchBar'
import { SCHED_DEFAULTS } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'
import type { RoutineAssistantPatch } from './routine-assist'

/** Editor modes for the schedule, ordered by how common they are. */
const SCHEDULE_MODES = [
  { value: 'daily', label: '每天 · 固定时间' },
  { value: 'weekly', label: '每周 · 指定星期' },
  { value: 'monthly', label: '每月 · 指定日期' },
  { value: 'interval', label: '每隔一段时间' },
  { value: 'custom', label: '高级 · cron 表达式' },
]

/** Weekday options in display order (周一 first; cron 0=周日 stays last). */
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: WEEKDAY_LABELS[d] }))

const DEFAULT_TIME = '09:00'
const ROW_LABEL = { fontSize: 12, color: '#666' } as const
const CAPTION = { fontSize: 11, color: '#999', marginTop: 4 } as const

/** Built-in prompt variables (shared/routine/params builtinRoutineVars) — the
 *  runtime half the runner substitutes after the declared params. */
const BUILTIN_VAR_OPTIONS = [
  { value: 'date', label: '日期 {{date}}' },
  { value: 'time', label: '时间 {{time}}' },
  { value: 'datetime', label: '日期时间 {{datetime}}' },
  { value: 'weekday', label: '星期 {{weekday}}' },
  { value: 'workspace', label: '工作区路径 {{workspace}}' },
]

/** Approval ladder — same three levels and order as the composer's 授权
 *  button (chatView.approval.*); undefined = the unattended default. */
const APPROVAL_OPTIONS = [
  { value: 'always-ask', label: '始终询问' },
  { value: 'outside-ask', label: '按需确认' },
  { value: 'auto', label: '全部允许' },
]

/** Labels carry the structure on their own (the section headings are gone),
 *  so they are set a weight above the inputs — same as the expert form. */
function FieldLabel({ text }: { text: string }): React.ReactElement {
  return <div style={{ marginBottom: 6, fontWeight: 600 }}>{text}</div>
}

/** One editor row per friendly schedule kind; each receives its already-narrowed
 *  config so the union never leaks into the input callbacks. */
function DailyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'daily' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <span style={ROW_LABEL}>每天</span>
      <Input type="time" style={{ width: 120 }} value={sched.time} onChange={(e) => onChange({ kind: 'daily', time: e.target.value || DEFAULT_TIME })} />
      <span style={ROW_LABEL}>执行一次</span>
    </div>
  )
}

function WeeklyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'weekly' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
      <Select
        mode="multiple"
        placeholder="选择星期"
        style={{ minWidth: 220, flex: 1 }}
        value={sched.weekdays}
        onChange={(weekdays) => onChange({ kind: 'weekly', weekdays, time: sched.time })}
        options={WEEKDAY_OPTIONS}
      />
      <Input type="time" style={{ width: 120 }} value={sched.time} onChange={(e) => onChange({ kind: 'weekly', weekdays: sched.weekdays, time: e.target.value || DEFAULT_TIME })} />
    </div>
  )
}

function MonthlyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'monthly' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <span style={ROW_LABEL}>每月</span>
      <InputNumber min={1} max={31} value={sched.day} onChange={(day) => onChange({ kind: 'monthly', day: day ?? 1, time: sched.time })} />
      <span style={ROW_LABEL}>日</span>
      <Input type="time" style={{ width: 120 }} value={sched.time} onChange={(e) => onChange({ kind: 'monthly', day: sched.day, time: e.target.value || DEFAULT_TIME })} />
    </div>
  )
}

function IntervalScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'interval' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
      <span style={ROW_LABEL}>每隔</span>
      <InputNumber
        min={1}
        max={sched.unit === 'minute' ? 59 : 23}
        value={sched.every}
        onChange={(every) => onChange({ kind: 'interval', unit: sched.unit, every: every ?? 1 })}
      />
      <Select
        style={{ width: 90 }}
        value={sched.unit}
        onChange={(unit) => onChange({ kind: 'interval', unit, every: sched.every })}
        options={[{ value: 'minute', label: '分钟' }, { value: 'hour', label: '小时' }]}
      />
      <span style={ROW_LABEL}>执行一次</span>
    </div>
  )
}

function CustomScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'custom' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <Input
      style={{ marginTop: 8 }}
      value={sched.cron}
      onChange={(e) => onChange({ kind: 'custom', cron: e.target.value })}
      placeholder="0 9 * * 1-5"
    />
  )
}

/** The 定时执行 block: switch, mode picker, per-kind rows, next-run hint and
 *  the missed-fire policy. Split from RoutineForm to keep each component small. */
function ScheduleSection({ draft, onChange }: { draft: RoutineDraftState; onChange: (draft: RoutineDraftState) => void }): React.ReactElement {
  const cronCheck = draft.sched.kind === 'custom' ? checkCron(draft.sched.cron) : null
  const hint = (): React.ReactNode => {
    if (!draft.scheduleEnabled) return '不设置定时，只能手动执行。'
    if (draft.sched.kind === 'custom') {
      return cronCheck?.valid
        ? `下次运行：${new Date(nextRun(draft.sched.cron)!).toLocaleString()}`
        : `表达式无效：${cronCheck?.error ?? ''}`
    }
    const next = nextRun(configToCron(draft.sched))
    return next ? `下次运行：${new Date(next).toLocaleString()}` : null
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600 }}>定时执行</span>
        <Switch size="small" checked={draft.scheduleEnabled} onChange={(scheduleEnabled) => onChange({ ...draft, scheduleEnabled })} />
      </div>
      {draft.scheduleEnabled && (
        <>
          <Select
            style={{ width: '100%', marginTop: 8 }}
            value={draft.sched.kind}
            onChange={(kind) => onChange({
              ...draft,
              sched: kind === 'custom'
                ? { kind: 'custom', cron: draft.sched.kind === 'custom' ? draft.sched.cron : '0 9 * * *' }
                : { ...SCHED_DEFAULTS[kind], ...(('time' in draft.sched) ? { time: draft.sched.time } : {}) },
            })}
            options={SCHEDULE_MODES}
          />
          {draft.sched.kind === 'daily' && <DailyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'weekly' && <WeeklyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'monthly' && <MonthlyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'interval' && <IntervalScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'custom' && <CustomScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          <div style={{ ...CAPTION, color: cronCheck && !cronCheck.valid ? '#cf1322' : '#999' }}>
            {hint()}
          </div>
          <div style={{ marginTop: 12 }}>
            <FieldLabel text="错过计划时（应用没开着）" />
            <Select
              value={draft.catchUp}
              onChange={(catchUp) => onChange({ ...draft, catchUp })}
              options={[
                { value: 'once', label: '打开应用后补跑一次' },
                { value: 'skip', label: '跳过，等下一个计划点' },
              ]}
              style={{ width: 240 }}
            />
          </div>
        </>
      )}
      {!draft.scheduleEnabled && <div style={CAPTION}>{hint()}</div>}
    </div>
  )
}

/** Undo bar for the assistant's auto-applied patch (user ruling 2026-09-20:
 *  no review card — the patch lands in the form directly and this bar is the
 *  way back). Sits at the top of the form column, where the review card used
 *  to be. */
function RoutineAppliedBar({ applied, onUndo }: { applied: RoutineAssistantPatch; onUndo: () => void }): React.ReactElement {
  const { t } = useTranslation()
  const summary = `${t('formAssist.autoFilled')}${applied.name ? `：「${applied.name}」` : ''}`
  return <AppliedPatchBar summary={summary} onUndo={onUndo} />
}

/** The 批量数据 block (PLAN-routine-batch M5): an optional CSV whose headers
 *  map to the params above. The file itself is read main-side (preview IPC) —
 *  the section only shows its verdict: mapping badges on the header row, the
 *  first rows, and why a run would refuse (missing required column / over the
 *  row cap). The read carries no params: the mapping is recomputed on every
 *  render from the cached headers (analyzeCsvBatch), so a param keystroke
 *  never re-reads the file. */
function BatchSection({ draft, onChange }: { draft: RoutineDraftState; onChange: (draft: RoutineDraftState) => void }): React.ReactElement {
  /** The read result tagged with the path it came from — a mismatch (file
   *  switched, read still in flight) renders as "nothing yet" instead of the
   *  previous file's verdict, which is what lets the effect stay async-only. */
  const [entry, setEntry] = React.useState<{ path: string; preview: CsvPreview | null; error: string | null } | null>(null)
  const csvPath = draft.batch?.csvPath ?? ''

  React.useEffect(() => {
    if (!csvPath) return
    let cancelled = false
    void window.electronAPI.routineCsvPreview(csvPath, undefined)
      .then((res) => {
        if (cancelled) return
        setEntry({
          path: csvPath,
          preview: res.ok && res.preview ? res.preview : null,
          error: res.ok ? null : (res.error ?? '读取批量数据文件失败'),
        })
      })
      .catch(() => { if (!cancelled) setEntry({ path: csvPath, preview: null, error: '读取批量数据文件失败' }) })
    return () => { cancelled = true }
  }, [csvPath])

  const current = entry?.path === csvPath ? entry : null
  const preview = current?.preview ?? null
  const error = current?.error ?? null
  // Live mapping over the cached headers; empty rows are fine — only the
  // header verdict is recomputed, the row count already lives on the preview.
  const liveAnalysis = preview ? analyzeCsvBatch(preview.headers, [], draft.params) : null

  const pick = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      })
      const p = res.filePaths[0]
      if (!res.canceled && p) onChange({ ...draft, batch: { ...(draft.batch ?? {}), csvPath: p } })
    } catch { /* dialog is best-effort; the section stays as it was */ }
  }

  const shownHeaders = preview?.headers.slice(0, 8) ?? []
  return (
    <div data-routine-field="batch">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <FieldLabel text="批量数据（CSV）" />
        {draft.batch && (
          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange({ ...draft, batch: undefined })}>
            清除
          </Button>
        )}
      </div>
      {!draft.batch ? (
        <>
          <Button type="dashed" block icon={<FileTextOutlined />} onClick={() => void pick()}>选择 CSV 文件</Button>
          <div style={CAPTION}>选配后可批量执行：表头对应上面的参数名，每一行数据都会用独立会话跑一次任务。</div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-routine-field="batch-file">
            <Tag style={{ marginInlineEnd: 0, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} icon={<FileTextOutlined />}>
              {draft.batch.csvPath}
            </Tag>
            <Button size="small" onClick={() => void pick()}>更换…</Button>
          </div>
          {error && <div style={{ ...CAPTION, color: '#cf1322', marginTop: 8 }}>{error}</div>}
          {preview && (
            <>
              <div style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 8, overflow: 'hidden', marginTop: 10 }} data-routine-batch-preview>
                <div style={{ display: 'flex', background: 'var(--pm-fill)' }}>
                  {shownHeaders.map((h) => {
                    const param = draft.params.find((p) => p.key === h)
                    return (
                      <div key={h} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {param ? <span style={{ color: '#389e0d' }}>{h} · {param.label || param.key}</span> : <span style={{ color: '#999' }}>{h} · 未使用</span>}
                      </div>
                    )
                  })}
                  {(preview.headers.length ?? 0) > shownHeaders.length && (
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
              <div style={CAPTION}>共 {preview.totalRows} 行数据，预览前 {preview.previewRows.length} 行。</div>
              {liveAnalysis && liveAnalysis.missingRequiredHeaders.length > 0 && (
                <div style={{ ...CAPTION, color: '#cf1322' }}>缺少必填参数的列：{liveAnalysis.missingRequiredHeaders.join('、')} —— 运行会被拒绝</div>
              )}
              {liveAnalysis && liveAnalysis.unmatchedHeaders.length > 0 && (
                <div style={CAPTION}>未匹配参数的列（将忽略）：{liveAnalysis.unmatchedHeaders.join('、')}</div>
              )}
              {preview.overRowLimit && (
                <div style={{ ...CAPTION, color: '#cf1322' }}>共 {preview.totalRows} 行，超过单批 {MAX_BATCH_ROWS} 行上限，运行会被拒绝，请拆分文件</div>
              )}
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <FieldLabel text="并发执行" />
            <Select
              style={{ width: 200 }}
              value={draft.batch.concurrency ?? DEFAULT_BATCH_CONCURRENCY}
              onChange={(concurrency) => onChange({ ...draft, batch: { ...draft.batch!, concurrency } })}
              options={Array.from({ length: MAX_BATCH_CONCURRENCY }, (_, i) => ({ value: i + 1, label: `同时执行 ${i + 1} 行` }))}
            />
            <div style={CAPTION}>每一行都是独立会话；并发越大完成越快，也越占模型额度。</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Switch
                size="small"
                checked={!!draft.batch.applyToSchedule}
                onChange={(applyToSchedule) => onChange({ ...draft, batch: { ...draft.batch!, applyToSchedule } })}
              />
              <span style={ROW_LABEL}>定时触发时也执行批量</span>
            </div>
            <div style={CAPTION}>关闭时定时触发仍按默认参数单次执行，批量只能手动启动。</div>
          </div>
        </>
      )}
    </div>
  )
}

/** The 运行环境 block: where the run executes, how freely, and on which model.
 *  Every field is optional — absent = the conversation-default behavior (a
 *  minted session folder under the global workspace / the unattended approval
 *  level / the active profile at run time), stated in the captions so an
 *  untouched form is never a mystery. */
function RunContextSection({ draft, onChange, models, activeModelId }: {
  draft: RoutineDraftState
  onChange: (draft: RoutineDraftState) => void
  models: Array<{ id: string; name: string }>
  activeModelId?: string
}): React.ReactElement {
  const pickWorkspaceDir = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
      if (!res.canceled && res.filePaths[0]) onChange({ ...draft, workspaceDir: res.filePaths[0] })
    } catch { /* dialog is best-effort; the input stays hand-editable */ }
  }
  // A stored routine can point at a since-deleted profile — keep the raw value
  // visible (and clearable) instead of antd printing the bare id.
  const modelValue = draft.profileId
  const modelOptions = models.map((p) => ({
    value: p.id,
    label: p.id === activeModelId ? `${p.name}（当前）` : p.name,
  }))
  if (modelValue && !models.some((p) => p.id === modelValue)) {
    modelOptions.unshift({ value: modelValue, label: `${modelValue}（已删除，将使用当前模型）` })
  }
  return (
    <div>
      <div>
        <FieldLabel text="工作区" />
        <div style={{ display: 'flex', gap: 8 }} data-routine-field="workspace">
          <Input
            style={{ flex: 1 }}
            value={draft.workspaceDir ?? ''}
            placeholder="默认：全局工作区下的会话专用目录"
            onChange={(e) => onChange({ ...draft, workspaceDir: e.target.value })}
            allowClear
          />
          <Button onClick={() => void pickWorkspaceDir()}>选择…</Button>
        </div>
        <div style={CAPTION}>不填则在全局工作区下新建本次运行的专用目录，与普通对话一致。</div>
      </div>
      <div style={{ marginTop: 14 }} data-routine-field="approval">
        <FieldLabel text="授权方式" />
        <Select
          style={{ width: 220 }}
          value={draft.approvalMode}
          placeholder="按需确认（默认）"
          allowClear
          onChange={(approvalMode) => onChange({ ...draft, approvalMode: approvalMode as SandboxApprovalMode | undefined })}
          options={APPROVAL_OPTIONS}
        />
        <div style={CAPTION}>无人值守运行时，该等级不允许的操作会被自动跳过，不会卡住等待。</div>
      </div>
      <div style={{ marginTop: 14 }} data-routine-field="model">
        <FieldLabel text="模型" />
        <Select
          style={{ width: '100%' }}
          value={modelValue}
          placeholder={models.find((p) => p.id === activeModelId)?.name
            ? `使用当前模型（${models.find((p) => p.id === activeModelId)?.name}）`
            : '使用当前模型'}
          allowClear
          onChange={(profileId) => onChange({ ...draft, profileId: profileId ?? undefined })}
          options={modelOptions}
        />
        <div style={CAPTION}>不选则使用运行时的当前模型；所选模型被删除后同样回落到当前模型。</div>
      </div>
    </div>
  )
}

export interface RoutineFormProps {
  draft: RoutineDraftState
  onChange: (draft: RoutineDraftState) => void
  /** Non-null = the assistant's latest patch is in this form; the undo bar
   *  offers the way back (a newer patch replaces it, a prose reply or the
   *  undo itself retires it). */
  appliedAssistantPatch: RoutineAssistantPatch | null
  onUndoAssistantPatch: () => void
  /** Model profiles for the 模型 select, narrowed to what a picker needs
   *  (id + display name) — the credentials never belong in a form component. */
  models: Array<{ id: string; name: string }>
  activeModelId?: string
}

export function RoutineForm({ draft, onChange, appliedAssistantPatch, onUndoAssistantPatch, models, activeModelId }: RoutineFormProps): React.ReactElement {
  // The native <textarea> under antd's TextArea — insertion at the caret needs
  // the real element's selectionStart/selectionEnd.
  const promptAreaRef = React.useRef<{ resizableTextArea?: { textArea?: HTMLTextAreaElement } } | null>(null)
  const declaredVars = draft.params
    .filter((p) => p.key.trim())
    .map((p) => ({ value: p.key, label: `${p.label || p.key} {{${p.key}}}` }))
  const insertVar = (key: string): void => {
    const token = `{{${key}}}`
    const area = promptAreaRef.current?.resizableTextArea?.textArea
    const start = area?.selectionStart ?? draft.prompt.length
    const end = area?.selectionEnd ?? start
    onChange({ ...draft, prompt: draft.prompt.slice(0, start) + token + draft.prompt.slice(end) })
    const caret = start + token.length
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(caret, caret)
    })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {appliedAssistantPatch && <RoutineAppliedBar applied={appliedAssistantPatch} onUndo={onUndoAssistantPatch} />}
      <div>
        <FieldLabel text="任务名称" />
        <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="例如：每日依赖巡检" autoFocus />
      </div>
      <div>
        <FieldLabel text="描述" />
        <Input value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} placeholder="可选，一句话说明这个任务做什么" />
      </div>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }} data-routine-field="prompt-head">
          <FieldLabel text="提示词" />
          {/* An action, not a state: the value stays unset so the control
              reads 插入变量 again after every pick. */}
          <Select
            size="small"
            style={{ minWidth: 110 }}
            value={null}
            placeholder="插入变量"
            onChange={insertVar}
            options={[
              { label: '内置变量', options: BUILTIN_VAR_OPTIONS },
              ...(declaredVars.length > 0 ? [{ label: '任务参数', options: declaredVars }] : []),
            ]}
          />
        </div>
        <Input.TextArea
          ref={promptAreaRef}
          value={draft.prompt}
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
          rows={8}
          placeholder="独立可执行的指令，例如：检查 {{repo}} 仓库的依赖是否有已知安全漏洞，输出报告。用 {{参数名}} 引用下面的参数。"
        />
      </div>
      <div>
        <FieldLabel text="参数" />
        {draft.params.map((p, i) => (
          <Space key={i} style={{ display: 'flex', marginBottom: 6 }}>
            <Input style={{ width: 110 }} value={p.key} placeholder="参数名" onChange={(e) => {
              const params = [...draft.params]; params[i] = { ...p, key: e.target.value }; onChange({ ...draft, params })
            }} />
            <Input style={{ width: 120 }} value={p.label} placeholder="显示名" onChange={(e) => {
              const params = [...draft.params]; params[i] = { ...p, label: e.target.value }; onChange({ ...draft, params })
            }} />
            <Input style={{ width: 140 }} value={p.default} placeholder="默认值" onChange={(e) => {
              const params = [...draft.params]; params[i] = { ...p, default: e.target.value }; onChange({ ...draft, params })
            }} />
            {/* 必填 completes the params loop on the authoring side: a required
                param without a value refuses to run (RoutineRunModal enforces
                it on 立即运行, the runner gates every trigger). */}
            <Checkbox
              checked={!!p.required}
              onChange={(e) => {
                const params = [...draft.params]; params[i] = { ...p, required: e.target.checked }; onChange({ ...draft, params })
              }}
            >
              必填
            </Checkbox>
            <Button type="text" danger icon={<DeleteOutlined />} onClick={() => onChange({ ...draft, params: draft.params.filter((_, j) => j !== i) })} />
          </Space>
        ))}
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => onChange({ ...draft, params: [...draft.params, { key: '', label: '' }] })}>
          添加参数
        </Button>
      </div>
      <BatchSection draft={draft} onChange={onChange} />
      <RunContextSection draft={draft} onChange={onChange} models={models} activeModelId={activeModelId} />
      <ScheduleSection draft={draft} onChange={onChange} />
    </div>
  )
}
