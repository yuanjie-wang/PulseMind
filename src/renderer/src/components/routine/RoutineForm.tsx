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
import { Button, Checkbox, Input, InputNumber, Select, Space, Switch } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { checkCron, nextRun } from '../../../../shared/schedule/cron'
import { configToCron, WEEKDAY_LABELS } from '../../utils/schedule-builder'
import type { ScheduleConfig } from '../../utils/schedule-builder'
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

export interface RoutineFormProps {
  draft: RoutineDraftState
  onChange: (draft: RoutineDraftState) => void
  /** Non-null = the assistant's latest patch is in this form; the undo bar
   *  offers the way back (a newer patch replaces it, a prose reply or the
   *  undo itself retires it). */
  appliedAssistantPatch: RoutineAssistantPatch | null
  onUndoAssistantPatch: () => void
}

export function RoutineForm({ draft, onChange, appliedAssistantPatch, onUndoAssistantPatch }: RoutineFormProps): React.ReactElement {
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
        <FieldLabel text="提示词" />
        <Input.TextArea
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
      <ScheduleSection draft={draft} onChange={onChange} />
    </div>
  )
}
