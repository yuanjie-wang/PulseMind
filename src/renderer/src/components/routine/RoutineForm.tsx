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
import { Button, Checkbox, Input, InputNumber, Segmented, Select, Space, Switch, Tag, TimePicker } from 'antd'
import { ClockCircleOutlined, DeleteOutlined, FileTextOutlined, PlusOutlined, RedoOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
// dayjs(string, format) needs the parser plugin registered before any
// TimeInput converts its "HH:mm" draft value — module scope, once.
dayjs.extend(customParseFormat)
import { checkCron, nextRun } from '../../../../shared/schedule/cron'
import { configToCron, WEEKDAY_LABELS } from '../../utils/schedule-builder'
import type { ScheduleConfig } from '../../utils/schedule-builder'
import type { SandboxApprovalMode } from '../../../../shared/sandbox/policy'
import { analyzeCsvBatch, BATCH_TIMEOUT_MINUTE_OPTIONS, DEFAULT_BATCH_CONCURRENCY, DEFAULT_BATCH_TIMEOUT_MINUTES, MAX_BATCH_ROWS, MAX_BATCH_CONCURRENCY, mergeHeaderParams } from '../../../../shared/routine/batch'
import type { CsvPreview } from '../../../../shared/routine/batch'
import { useTranslation } from '../../i18n/useTranslation'
import { AppliedPatchBar } from '../form-assist/AppliedPatchBar'
import { SCHED_DEFAULTS } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'
import type { RoutineAssistantPatch } from './routine-assist'
import type { RoutineTrigger, RoutineWebhookTrigger } from '../../../../shared/types/routine'
import { ROUTINE_WEBHOOK_UI } from '../../feature-flags'

/** Schedule kinds in Segmented order; short labels — the block control splits
 *  the row evenly, the friendly detail lives in the row below it. */
const SCHEDULE_KINDS = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'interval', label: '每隔' },
  { value: 'custom', label: 'Cron' },
]

/** Weekday options in display order (周一 first; cron 0=周日 stays last). */
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: WEEKDAY_LABELS[d] }))

const DEFAULT_TIME = '09:00'
const ROW_LABEL = { fontSize: 12, color: 'var(--pm-text-secondary)' } as const
const CAPTION = { fontSize: 11, color: 'var(--pm-text-muted)', marginTop: 4 } as const

/** The recessed card the enabled schedule body sits in — one hairline box
 *  groups the picker, the per-kind rows and the missed-fire policy, so the
 *  header switch reads as the toggle of the whole block. */
const SCHED_PANEL = {
  marginTop: 10,
  padding: 12,
  background: 'var(--pm-fill-ghost)',
  border: '1px solid var(--pm-border-hairline)',
  borderRadius: 10,
} as const

/** One config line inside the panel, above the hint. */
const SCHED_ROW = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } as const

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

/** antd's time picker, not the native <input type=time> (user 2026-09-23:
 *  「不要用蓝色风格」— the native field paints its focused segment with the
 *  browser accent blue, and no CSS reaches it: accent-color computes but the
 *  highlight ignores it). The antd picker takes the app theme (ink primary,
 *  the shared 8px radius), showNow drops the panel's link-blue 此刻 button,
 *  and format pins a 24h HH:mm that no longer follows the OS locale. The
 *  draft keeps its "HH:mm" string — converted at both edges, and a cleared
 *  value falls back to the default exactly as the native field did. */
function TimeInput({ value, onChange }: { value: string; onChange: (time: string) => void }): React.ReactElement {
  const picked = dayjs(value, 'HH:mm')
  return (
    <TimePicker
      format="HH:mm"
      showNow={false}
      style={{ width: 110 }}
      value={picked.isValid() ? picked : undefined}
      onChange={(time) => onChange(time ? time.format('HH:mm') : DEFAULT_TIME)}
    />
  )
}

/** 周一…周日 as toggle chips — the multi-select this replaced needed a dropdown
 *  round-trip to see which days are on; these read at a glance. Selected takes
 *  the app's solid-ink look; the stored order stays the display order, so a
 *  saved 周三、周一 reads back as 周一、周三. */
function WeekdayChips({ value, onChange }: { value: number[]; onChange: (weekdays: number[]) => void }): React.ReactElement {
  const toggle = (day: number): void => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : [...value, day]
    onChange(WEEKDAY_OPTIONS.map((o) => o.value).filter((d) => next.includes(d)))
  }
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {WEEKDAY_OPTIONS.map(({ value: day, label }) => {
        const active = value.includes(day)
        return (
          <button
            key={day}
            type="button"
            className={active ? 'pm-sched-chip pm-sched-chip--active' : 'pm-sched-chip'}
            onClick={() => toggle(day)}
            style={{
              flex: 1,
              height: 28,
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 12,
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${active ? 'var(--pm-ink)' : 'var(--pm-border)'}`,
              background: active ? 'var(--pm-ink)' : 'transparent',
              color: active ? 'var(--pm-ink-contrast)' : 'var(--pm-text-secondary)',
              transition: 'background 0.15s, border-color 0.15s, color 0.15s',
            }}
          >
            {label.slice(1)}
          </button>
        )
      })}
    </div>
  )
}

/** One editor row per friendly schedule kind; each receives its already-narrowed
 *  config so the union never leaks into the input callbacks. */
function DailyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'daily' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={SCHED_ROW}>
      <span style={ROW_LABEL}>每天</span>
      <TimeInput value={sched.time} onChange={(time) => onChange({ kind: 'daily', time })} />
    </div>
  )
}

function WeeklyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'weekly' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <WeekdayChips value={sched.weekdays} onChange={(weekdays) => onChange({ kind: 'weekly', weekdays, time: sched.time })} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={ROW_LABEL}>时间</span>
        <TimeInput value={sched.time} onChange={(time) => onChange({ kind: 'weekly', weekdays: sched.weekdays, time })} />
      </div>
    </div>
  )
}

function MonthlyScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'monthly' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={SCHED_ROW}>
      <span style={ROW_LABEL}>每月</span>
      <InputNumber min={1} max={31} style={{ width: 72 }} value={sched.day} onChange={(day) => onChange({ kind: 'monthly', day: day ?? 1, time: sched.time })} />
      <span style={ROW_LABEL}>日</span>
      <TimeInput value={sched.time} onChange={(time) => onChange({ kind: 'monthly', day: sched.day, time })} />
    </div>
  )
}

function IntervalScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'interval' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <div style={SCHED_ROW}>
      <span style={ROW_LABEL}>每隔</span>
      <InputNumber
        min={1}
        max={sched.unit === 'minute' ? 59 : 23}
        style={{ width: 72 }}
        value={sched.every}
        onChange={(every) => onChange({ kind: 'interval', unit: sched.unit, every: every ?? 1 })}
      />
      <Select
        style={{ width: 84 }}
        value={sched.unit}
        onChange={(unit) => {
          // 单位切换必须夹紧 every（full_20261011 M4-P1-2）：30 分钟切到小时
          // 曾原样保留 30——输入框显示超过自己 max 的值，落库 0 */30 * * *，
          // 实际每天 00:00 跑一次而界面说「每隔 30 小时」。一处夹紧两个方向。
          const max = unit === 'minute' ? 59 : 23
          const every = Math.min(Math.max(sched.every, 1), max)
          onChange({ kind: 'interval', unit, every })
        }}
        options={[{ value: 'minute', label: '分钟' }, { value: 'hour', label: '小时' }]}
      />
    </div>
  )
}

function CustomScheduleRow({ sched, onChange }: { sched: Extract<ScheduleConfig, { kind: 'custom' }>; onChange: (sched: ScheduleConfig) => void }): React.ReactElement {
  return (
    <Input
      style={{ marginTop: 10 }}
      value={sched.cron}
      onChange={(e) => onChange({ kind: 'custom', cron: e.target.value })}
      placeholder="0 9 * * 1-5　（分 时 日 月 周）"
    />
  )
}

/** The 定时执行 block: switch, kind Segmented, per-kind rows, next-run hint and
 *  the missed-fire policy. The enabled body sits in SCHED_PANEL so the whole
 *  block reads as one control; split from RoutineForm to keep each component
 *  small. */
function ScheduleSection({ draft, onChange }: { draft: RoutineDraftState; onChange: (draft: RoutineDraftState) => void }): React.ReactElement {
  const cronCheck = draft.sched.kind === 'custom' ? checkCron(draft.sched.cron) : null
  const cronInvalid = !!cronCheck && !cronCheck.valid
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
  const pickKind = (kind: ScheduleConfig['kind']): void => {
    onChange({
      ...draft,
      sched: kind === 'custom'
        ? { kind: 'custom', cron: draft.sched.kind === 'custom' ? draft.sched.cron : '0 9 * * *' }
        : { ...SCHED_DEFAULTS[kind], ...(('time' in draft.sched) ? { time: draft.sched.time } : {}) },
    })
  }
  return (
    <div data-routine-field="schedule">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ClockCircleOutlined style={{ color: draft.scheduleEnabled ? 'var(--pm-ink)' : 'var(--pm-text-muted)' }} />
          定时执行
        </span>
        <Switch size="small" checked={draft.scheduleEnabled} onChange={(scheduleEnabled) => onChange({ ...draft, scheduleEnabled })} />
      </div>
      {draft.scheduleEnabled ? (
        <div className="pm-sched-panel" style={SCHED_PANEL}>
          <Segmented
            block
            value={draft.sched.kind}
            onChange={(kind) => pickKind(kind as ScheduleConfig['kind'])}
            options={SCHEDULE_KINDS}
          />
          {draft.sched.kind === 'daily' && <DailyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'weekly' && <WeeklyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'monthly' && <MonthlyScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'interval' && <IntervalScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          {draft.sched.kind === 'custom' && <CustomScheduleRow sched={draft.sched} onChange={(sched) => onChange({ ...draft, sched })} />}
          <div
            className="pm-sched-hint"
            style={{
              ...CAPTION,
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: cronInvalid ? 'var(--pm-error)' : 'var(--pm-text-muted)',
            }}
          >
            {!cronInvalid && <ClockCircleOutlined />}
            {hint()}
          </div>
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--pm-border-hairline)' }}>
            <FieldLabel text="错过计划时（应用没开着）" />
            {/* antd 6 removed Select's `block`; width:100% is the documented equivalent */}
            <Select
              style={{ width: '100%' }}
              value={draft.catchUp}
              onChange={(catchUp) => onChange({ ...draft, catchUp })}
              options={[
                { value: 'once' as const, label: '打开应用后补跑一次' },
                { value: 'skip' as const, label: '跳过，等下一个计划点' },
              ]}
            />
          </div>
        </div>
      ) : (
        <div style={CAPTION}>{hint()}</div>
      )}
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

/** The 批量数据 block (PLAN-routine-batch M5): an optional CSV/Excel file whose
 *  headers map to the params above. The file itself is read main-side (preview
 *  IPC — .csv/.txt through the GBK-fallback parser, .xlsx through its first
 *  worksheet) — the section only shows its verdict: mapping badges on the
 *  header row, the first rows, and why a run would refuse (missing required
 *  column / over the row cap). The read carries no params: the mapping is
 *  recomputed on every render from the cached headers (analyzeCsvBatch), so a
 *  param keystroke never re-reads the file.
 *
 *  Header→param auto-import (user 2026-10-11): a successful preview that was
 *  ARMED by an explicit pick merges every not-yet-declared header into the
 *  params (mergeHeaderParams) — no manual param editing. The arm flag is what
 *  keeps re-opening a saved routine from resurrecting params the user deleted:
 *  the mount preview runs unarmed. Re-picking the SAME file bumps `readTick`
 *  (the path effect alone wouldn't re-fire), so the re-read re-syncs — that is
 *  the recovery path for an over-deleted param list. */
function BatchSection({ draft, onChange }: { draft: RoutineDraftState; onChange: (draft: RoutineDraftState) => void }): React.ReactElement {
  /** The read result tagged with the path it came from — a mismatch (file
   *  switched, read still in flight) renders as "nothing yet" instead of the
   *  previous file's verdict, which is what lets the effect stay async-only. */
  const [entry, setEntry] = React.useState<{ path: string; preview: CsvPreview | null; error: string | null } | null>(null)
  const csvPath = draft.batch?.csvPath ?? ''
  /** Latest-ref pair for the async sync: the preview's .then must merge into
   *  the draft the user is editing NOW (they may have typed params while the
   *  read was in flight), not the one captured when the effect ran — and the
   *  refs keep the preview effect's deps down to [csvPath, readTick] (a fresh
   *  onChange identity per render would otherwise re-preview on every
   *  keystroke). Synced from a deps-less effect, never during render — the
   *  IPC round trip is always at least a task long, so the refs are current
   *  by the time the preview settles. */
  const draftRef = React.useRef(draft)
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => {
    draftRef.current = draft
    onChangeRef.current = onChange
  })
  /** Set by an explicit pick, consumed by the next settled preview. */
  const pendingSyncRef = React.useRef(false)
  /** Re-read nonce for a same-path re-pick. */
  const [readTick, setReadTick] = React.useState(0)

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
        if (pendingSyncRef.current) {
          pendingSyncRef.current = false
          if (res.ok && res.preview) {
            const base = draftRef.current
            const merged = mergeHeaderParams(base.params, res.preview.headers)
            if (merged.length > (base.params?.length ?? 0)) {
              onChangeRef.current({ ...base, params: merged })
            }
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          pendingSyncRef.current = false
          setEntry({ path: csvPath, preview: null, error: '读取批量数据文件失败' })
        }
      })
    return () => { cancelled = true }
  }, [csvPath, readTick])

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
        filters: [{ name: '批量数据', extensions: ['csv', 'txt', 'xlsx'] }],
      })
      const p = res.filePaths[0]
      if (!res.canceled && p) {
        pendingSyncRef.current = true
        // Same file re-picked: the path effect won't re-fire on an unchanged
        // path, so bump the read tick — the re-read re-syncs the headers
        // (restores params the user has since deleted).
        if (p === csvPath) setReadTick((t) => t + 1)
        else onChange({ ...draft, batch: { ...(draft.batch ?? {}), csvPath: p } })
      }
    } catch { /* dialog is best-effort; the section stays as it was */ }
  }

  const shownHeaders = preview?.headers.slice(0, 8) ?? []
  return (
    <div data-routine-field="batch">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <FieldLabel text="批量数据（CSV / Excel）" />
        {draft.batch && (
          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onChange({ ...draft, batch: undefined })}>
            清除
          </Button>
        )}
      </div>
      {!draft.batch ? (
        <>
          <Button type="dashed" block icon={<FileTextOutlined />} onClick={() => void pick()}>选择数据文件</Button>
          <div style={CAPTION}>选配后可批量执行：选择文件后表头自动识别为变量（可在上方参数中调整），每一行数据都会用独立会话跑一次任务。</div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-routine-field="batch-file">
            <Tag style={{ marginInlineEnd: 0, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} icon={<FileTextOutlined />}>
              {draft.batch.csvPath}
            </Tag>
            <Button size="small" onClick={() => void pick()}>更换…</Button>
          </div>
          {error && <div style={{ ...CAPTION, color: 'var(--pm-error)', marginTop: 8 }}>{error}</div>}
          {preview && (
            <>
              <div style={{ border: '1px solid var(--pm-border-hairline)', borderRadius: 8, overflow: 'hidden', marginTop: 10 }} data-routine-batch-preview>
                <div style={{ display: 'flex', background: 'var(--pm-fill)' }}>
                  {shownHeaders.map((h) => {
                    const param = draft.params.find((p) => p.key === h)
                    return (
                      <div key={h} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {param ? <span style={{ color: 'var(--pm-success)' }}>{h} · {param.label || param.key}</span> : <span style={{ color: 'var(--pm-text-muted)' }}>{h} · 未使用</span>}
                      </div>
                    )
                  })}
                  {(preview.headers.length ?? 0) > shownHeaders.length && (
                    <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--pm-text-muted)', flexShrink: 0 }}>+{preview.headers.length - shownHeaders.length} 列</div>
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
                <div style={{ ...CAPTION, color: 'var(--pm-error)' }}>缺少必填参数的列：{liveAnalysis.missingRequiredHeaders.join('、')} —— 运行会被拒绝</div>
              )}
              {liveAnalysis && liveAnalysis.unmatchedHeaders.length > 0 && (
                <div style={CAPTION}>未匹配参数的列（将忽略）：{liveAnalysis.unmatchedHeaders.join('、')}</div>
              )}
              {preview.overRowLimit && (
                <div style={{ ...CAPTION, color: 'var(--pm-error)' }}>共 {preview.totalRows} 行，超过单批 {MAX_BATCH_ROWS} 行上限，运行会被拒绝，请拆分文件</div>
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
            <FieldLabel text="单次超时" />
            <Select
              style={{ width: 200 }}
              value={draft.batch.timeoutMinutes ?? DEFAULT_BATCH_TIMEOUT_MINUTES}
              onChange={(timeoutMinutes) => onChange({ ...draft, batch: { ...draft.batch!, timeoutMinutes } })}
              options={BATCH_TIMEOUT_MINUTE_OPTIONS.map((m) => ({ value: m, label: `${m} 分钟` }))}
              data-batch-timeout
            />
            <div style={CAPTION}>批量的每一行、以及该任务的单笔运行，超过该时长未结束都会被停止并记为失败；默认 15 分钟。</div>
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
  models: Array<{ id: string; name: string; providerName?: string }>
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
  const toOption = (p: { id: string; name: string }) => ({
    value: p.id,
    label: p.id === activeModelId ? `${p.name}（当前）` : p.name,
  })
  // Grouped by 供应商 when more than one is in play; a single provider stays
  // flat (a lone group header is noise).
  const providerNames: string[] = []
  for (const p of models) {
    const name = p.providerName ?? ''
    if (!providerNames.includes(name)) providerNames.push(name)
  }
  const modelOptions: Array<{ value: string; label: string } | { label: string; options: Array<{ value: string; label: string }> }> =
    providerNames.length <= 1
      ? models.map(toOption)
      : providerNames.map((name) => ({
          label: name,
          options: models.filter((p) => (p.providerName ?? '') === name).map(toOption),
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

/** The 事件触发 block (PLAN-routine-triggers M1): local event sources that run
 *  the task outside the cron schedule — a watched file/folder, or a loopback
 *  webhook POST. The form manages AT MOST ONE of each; the stored type allows
 *  more but the UI has no reason to. The webhook token is displayed from the
 *  stored value; 重铸 just blanks it — the STORE mints the replacement at
 *  save, the UI never invents secrets. The webhook arm is gated off behind
 *  ROUTINE_WEBHOOK_UI (feature-flags) — stored webhook triggers keep firing,
 *  the switch and the fire URL just stop rendering. */
function TriggersSection({ draft, onChange }: { draft: RoutineDraftState; onChange: (draft: RoutineDraftState) => void }): React.ReactElement {
  const fileTrigger = draft.triggers?.find((t): t is Extract<RoutineTrigger, { type: 'file' }> => t.type === 'file')
  const webhookTrigger = draft.triggers?.find((t): t is RoutineWebhookTrigger => t.type === 'webhook')
  const setTriggers = (next: RoutineTrigger[]): void => onChange({ ...draft, triggers: next.length > 0 ? next : undefined })

  // The loopback port resolves once per mount; 0 = the endpoint is dormant —
  // the URL line then says so instead of showing a dead address. The fetch is
  // skipped while the webhook surface is gated off (feature-flags) — the port
  // feeds only the fire URL below.
  const [port, setPort] = React.useState(0)
  React.useEffect(() => {
    if (!ROUTINE_WEBHOOK_UI) return
    let cancelled = false
    void window.electronAPI.routineTriggersInfo()
      .then((info) => { if (!cancelled) setPort(info.port) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const fireUrl = draft.id && webhookTrigger?.token && port > 0
    ? `http://127.0.0.1:${port}/routine/${draft.id}/fire?token=${webhookTrigger.token}`
    : null

  const browsePath = async (): Promise<void> => {
    try {
      const res = await window.electronAPI.showOpenDialog({ properties: ['openDirectory', 'openFile'] })
      const p = res.filePaths[0]
      if (!res.canceled && p && fileTrigger && !fileTrigger.paths.includes(p)) {
        setTriggers((draft.triggers ?? []).map((t) => (t.type === 'file' ? { ...t, paths: [...t.paths, p] } : t)))
      }
    } catch { /* dialog is best-effort; the section stays as it was */ }
  }

  const patchFile = (patch: (t: Extract<RoutineTrigger, { type: 'file' }>) => RoutineTrigger): void => {
    setTriggers((draft.triggers ?? []).map((t) => (t.type === 'file' ? patch(t) : t)))
  }

  return (
    <div data-routine-field="triggers">
      <FieldLabel text="事件触发" />
      <div style={CAPTION}>除定时外，以下事件也会自动运行这个任务；应用关闭期间发生的事件不会补跑。</div>
      <div style={SCHED_ROW}>
        <Switch
          size="small"
          checked={!!fileTrigger}
          onChange={(on) => {
            setTriggers(on
              ? [...(draft.triggers ?? []).filter((t) => t.type !== 'file'), { type: 'file', paths: fileTrigger && fileTrigger.paths.length > 0 ? fileTrigger.paths : [''] }]
              : (draft.triggers ?? []).filter((t) => t.type !== 'file'))
          }}
        />
        <span style={ROW_LABEL}>文件变化时运行</span>
      </div>
      {fileTrigger && (
        <div style={{ marginTop: 8 }}>
          {fileTrigger.paths.map((p, i) => (
            <Space key={i} style={{ display: 'flex', marginBottom: 6 }}>
              <Input
                style={{ width: 330 }}
                value={p}
                placeholder="要监听的文件或文件夹（绝对路径）"
                onChange={(e) => {
                  const paths = [...fileTrigger.paths]
                  paths[i] = e.target.value
                  patchFile((t) => ({ ...t, paths }))
                }}
              />
              <Button size="small" onClick={browsePath}>浏览…</Button>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  const paths = fileTrigger.paths.filter((_, j) => j !== i)
                  if (paths.length > 0) patchFile((t) => ({ ...t, paths }))
                  else setTriggers((draft.triggers ?? []).filter((t) => t.type !== 'file'))
                }}
              />
            </Space>
          ))}
          <Space style={{ marginBottom: 6 }}>
            <Button
              size="small"
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => patchFile((t) => ({ ...t, paths: [...t.paths, ''] }))}
            >
              添加路径
            </Button>
            <span style={ROW_LABEL}>变化停止</span>
            <InputNumber
              size="small"
              min={1}
              max={60}
              value={Math.round((fileTrigger.debounceMs ?? 5000) / 1000)}
              onChange={(v) => patchFile((t) => ({ ...t, debounceMs: Number.isFinite(v) ? Number(v) * 1000 : undefined }))}
            />
            <span style={ROW_LABEL}>秒后运行</span>
          </Space>
        </div>
      )}
      {ROUTINE_WEBHOOK_UI && (
        <>
          <div style={SCHED_ROW}>
            <Switch
              size="small"
              checked={!!webhookTrigger}
              onChange={(on) => {
                setTriggers(on
                  ? [...(draft.triggers ?? []).filter((t) => t.type !== 'webhook'), { type: 'webhook', token: webhookTrigger?.token ?? '' }]
                  : (draft.triggers ?? []).filter((t) => t.type !== 'webhook'))
              }}
            />
            <span style={ROW_LABEL}>Webhook 触发</span>
          </div>
          {webhookTrigger && (
            <div style={{ marginTop: 8 }}>
              <div style={CAPTION}>向下面的地址发一个 POST 即运行一次任务（仅本机回环；外部服务的 webhook 请用你自己的桥转发到本机）。</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {fireUrl ? (
                  <>
                    <Input size="small" readOnly value={fireUrl} style={{ maxWidth: 430, fontSize: 11 }} />
                    <Button size="small" onClick={() => { void navigator.clipboard.writeText(fireUrl).catch(() => {}) }}>复制</Button>
                  </>
                ) : (
                  <span style={CAPTION}>
                    {draft.id ? (port > 0 ? '令牌尚未生成，保存任务后即可复制完整地址。' : '本会话的触发端点未启动。') : '保存任务后此处显示完整的触发地址。'}
                  </span>
                )}
                <Button
                  size="small"
                  icon={<RedoOutlined />}
                  onClick={() => setTriggers((draft.triggers ?? []).map((t) => (t.type === 'webhook' ? { ...t, token: '' } : t)))}
                >
                  重铸令牌
                </Button>
              </div>
            </div>
          )}
        </>
      )}
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
   *  (id + display name + the provider's display name for grouping) — the
   *  credentials never belong in a form component. */
  models: Array<{ id: string; name: string; providerName?: string }>
  activeModelId?: string
}

export function RoutineForm({ draft, onChange, appliedAssistantPatch, onUndoAssistantPatch, models, activeModelId }: RoutineFormProps): React.ReactElement {
  // The native <textarea> under antd's TextArea — insertion at the caret needs
  // the real element's selectionStart/selectionEnd.
  // The antd TextAreaRef itself, not a hand-shaped subset — a narrower local
  // shape is not assignable to the component's ref (TS2322) and antd may grow
  // the real one.
  const promptAreaRef = React.useRef<React.ComponentRef<typeof Input.TextArea> | null>(null)
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
      if (!area) return
      // Selection BEFORE focus: React's controlled write has already parked
      // the caret at the end of the new value, and focus() scrolls to the
      // caret — focusing first drags a long prompt's viewport to the tail,
      // and the later setSelectionRange moves the caret back without
      // bringing the view with it (probe-routine-var-insert).
      area.setSelectionRange(caret, caret)
      area.focus()
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
      <div data-routine-field="prompt">
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
      <TriggersSection draft={draft} onChange={onChange} />
    </div>
  )
}
