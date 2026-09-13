// ── Routine center (日常工作) ──
// PLAN-0.4.0 M4.3 / M4.4: card grid, and a three-pane run workspace (task
// list · run history · run transcript — see RoutineWorkspace) entered from a
// card's 运行历史 action. Routines are user-triggered / scheduled prompt tasks
// (D3), distinct from skills. Schedules are configured in friendly terms
// (每天/每周/每月/每隔) via utils/schedule-builder; raw cron is the "高级"
// escape hatch.

import React, { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Drawer, Input, InputNumber, Modal, Select, Space, Switch, Tag, Tooltip } from 'antd'
import { ClockCircleOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, HistoryOutlined, PlusOutlined, ImportOutlined, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { useNavigationStore } from '../../stores/navigationStore'
import { createLlmAdapter } from '../../llm'
import { RoutineExtractionAgent } from '../../agent/one-shot-agent'
import { checkCron, nextRun } from '../../../../shared/schedule/cron'
import { describeCron } from '../../utils/schedule-text'
import { parseCronToConfig, configToCron, WEEKDAY_LABELS } from '../../utils/schedule-builder'
import { describeRelativeTimeText } from '../../utils/relative-time'
import { RoutineWorkspace, RUN_STATUS_TAG } from './RoutineWorkspace'
import type { ScheduleConfig } from '../../utils/schedule-builder'
import type { Routine, RoutineRun } from '../../../../shared/types/routine'
import type { Project } from '../../../../shared/types/project'

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
const SCHED_DEFAULTS: Record<'daily' | 'weekly' | 'monthly' | 'interval', ScheduleConfig> = {
  daily: { kind: 'daily', time: DEFAULT_TIME },
  weekly: { kind: 'weekly', weekdays: [1], time: DEFAULT_TIME },
  monthly: { kind: 'monthly', day: 1, time: DEFAULT_TIME },
  interval: { kind: 'interval', unit: 'hour', every: 1 },
}

const ROW_LABEL = { fontSize: 12, color: '#666' } as const

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

interface RoutineDraftState {
  id?: string
  name: string
  description: string
  prompt: string
  scheduleEnabled: boolean
  sched: ScheduleConfig
  catchUp: 'once' | 'skip'
  enabled: boolean
  projectId?: string
  sourceConversationId?: string
  params: Array<{ key: string; label: string; required?: boolean; default?: string }>
}

const EMPTY_DRAFT: RoutineDraftState = {
  name: '', description: '', prompt: '', scheduleEnabled: false,
  sched: SCHED_DEFAULTS.daily, catchUp: 'once', enabled: true, params: [],
}

/** Draft schedule fields for a stored cron; unparseable expressions land in
 *  the custom editor so they survive a round-trip. */
function draftScheduleFromCron(cron: string): Pick<RoutineDraftState, 'scheduleEnabled' | 'sched'> {
  return cron ? { scheduleEnabled: true, sched: parseCronToConfig(cron) } : { scheduleEnabled: false, sched: SCHED_DEFAULTS.daily }
}

export interface RoutineCenterProps {
  /** Open a run's produced conversation in the chat view. */
  onOpenConversation?: (conversationKey: string) => void
}

function RoutineCenter({ onOpenConversation }: RoutineCenterProps): React.ReactElement {
  const { t } = useTranslation()
  const { modal, message } = AntdApp.useApp()
  const { settings } = useSettings()
  const navigate = useNavigationStore((s) => s.navigate)
  const [routines, setRoutines] = useState<Routine[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [recentRuns, setRecentRuns] = useState<RoutineRun[]>([])
  /** When recentRuns were fetched — render stays pure by not calling Date.now(). */
  const [runsFetchedAt, setRunsFetchedAt] = useState(0)
  const [draft, setDraft] = useState<RoutineDraftState | null>(null)
  /** Non-null = the run workspace is open for this task (three-pane mode). */
  const [historyOfId, setHistoryOfId] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractTarget, setExtractTarget] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Array<{ id: string; title: string }>>([])

  const reload = useCallback(async () => {
    try {
      setRoutines(await window.electronAPI.routineList())
      setProjects(await window.electronAPI.projectList())
      setRecentRuns(await window.electronAPI.routineRuns(undefined, 200))
      setRunsFetchedAt(Date.now())
    } catch (err) {
      console.warn('[RoutineCenter] load failed:', err)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  // Runs come back newest-first; the first hit per routine is its latest run.
  const lastRunByRoutine = new Map<string, RoutineRun>()
  for (const run of recentRuns) {
    if (!lastRunByRoutine.has(run.routineId)) lastRunByRoutine.set(run.routineId, run)
  }

  const cronCheck = draft?.scheduleEnabled && draft.sched.kind === 'custom' ? checkCron(draft.sched.cron) : null

  /** Hint line under the schedule editor: next fire time or the invalid cron. */
  const scheduleHint = (): React.ReactNode => {
    if (!draft?.scheduleEnabled) return '不设置定时，只能手动执行。'
    if (draft.sched.kind === 'custom') {
      return cronCheck?.valid
        ? `下次运行：${new Date(nextRun(draft.sched.cron)!).toLocaleString()}`
        : `表达式无效：${cronCheck?.error ?? ''}`
    }
    const next = nextRun(configToCron(draft.sched))
    return next ? `下次运行：${new Date(next).toLocaleString()}` : null
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft) return
    if (draft.scheduleEnabled) {
      if (draft.sched.kind === 'custom' && !checkCron(draft.sched.cron).valid) {
        message.error('cron 表达式无效')
        return
      }
      if (draft.sched.kind === 'weekly' && draft.sched.weekdays.length === 0) {
        message.error('请至少选择一个星期')
        return
      }
    }
    const cron = draft.scheduleEnabled ? configToCron(draft.sched) : ''
    const base = {
      name: draft.name.trim() || '未命名任务',
      description: draft.description,
      prompt: draft.prompt,
      enabled: draft.enabled,
      projectId: draft.projectId,
      sourceConversationId: draft.sourceConversationId,
      params: draft.params.filter((p) => p.key.trim()),
      schedule: cron ? { cron, catchUp: draft.catchUp } : undefined,
    }
    if (draft.id) await window.electronAPI.routineUpdate(draft.id, base)
    else await window.electronAPI.routineCreate(base)
    setDraft(null)
    void reload()
  }

  const runNow = async (routine: Routine): Promise<void> => {
    const params: Record<string, string> = {}
    for (const p of routine.params ?? []) params[p.key] = p.default ?? ''
    await window.electronAPI.routineRun(routine.id, params)
    message.success(`已开始执行「${routine.name}」，完成后会通知你`)
    void reload()
  }

  const removeRoutine = (routine: Routine): void => {
    modal.confirm({
      title: `删除「${routine.name}」？`,
      content: '运行历史会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await window.electronAPI.routineDelete(routine.id)
        void reload()
      },
    })
  }

  const extractFromConversation = async (): Promise<void> => {
    if (!extractTarget) return
    setExtracting(true)
    try {
      const conv = await window.electronAPI.getConversation(extractTarget)
      const lines: string[] = []
      for (const msg of conv?.messages ?? []) {
        const text = (msg.contentBlocks ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text?: string }).text ?? '')
          .join('\n')
        if (text) lines.push(`${msg.role === 'user' ? '用户' : '助手'}：${text}`)
      }
      const apiKey = settings.profiles.find((p) => p.id === settings.activeProfileId)?.apiKey
      if (!apiKey) {
        message.error('请先在设置中配置 API Key')
        return
      }
      const profile = settings.profiles.find((p) => p.id === settings.activeProfileId)
      const agent = new RoutineExtractionAgent()
      const draftResult = await agent.execute(
        { conversationText: lines.join('\n\n'), locale: settings.locale === 'en' ? 'en' : 'zh' },
        {
          llmConfig: {
            apiKey,
            baseURL: profile?.baseURL || '',
            model: profile?.model || '',
            adapter: createLlmAdapter(profile?.provider ?? 'anthropic'),
          },
        },
      )
      if (!draftResult) {
        message.warning('未能从该对话中提取出任务，试试另一个对话')
        return
      }
      setExtractOpen(false)
      setDraft({
        ...EMPTY_DRAFT,
        name: draftResult.name,
        description: draftResult.description,
        prompt: draftResult.prompt,
        ...draftScheduleFromCron(draftResult.cron),
        sourceConversationId: extractTarget,
      })
    } catch (err) {
      console.error('[RoutineCenter] extract failed:', err)
      message.error('提取失败')
    } finally {
      setExtracting(false)
    }
  }

  /** Fill the editor draft from a stored routine (card action + workspace). */
  const openEditor = (routine: Routine): void => {
    setDraft({
      id: routine.id,
      name: routine.name,
      description: routine.description,
      prompt: routine.prompt,
      ...draftScheduleFromCron(routine.schedule?.cron ?? ''),
      catchUp: routine.schedule?.catchUp ?? 'once',
      enabled: routine.enabled,
      projectId: routine.projectId,
      sourceConversationId: routine.sourceConversationId,
      params: routine.params ?? [],
    })
  }

  const openRunConversation = (conversationKey: string): void => {
    navigate({ kind: 'chat' })
    onOpenConversation?.(conversationKey)
  }

  return (
    <div style={{ height: '100%', background: '#fff', overflow: 'hidden' }}>
      {historyOfId != null ? (
        <RoutineWorkspace
          routines={routines}
          initialRoutineId={historyOfId}
          onBack={() => setHistoryOfId(null)}
          onEdit={openEditor}
          onRunNow={(r) => void runNow(r)}
          onOpenConversation={openRunConversation}
        />
      ) : (
        <div style={{ height: '100%', overflow: 'auto', padding: 24 }}>
          <style>{`
        .routine-card { transition: box-shadow 0.2s, border-color 0.2s; }
        .routine-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-color: #d9d9d9; }
        .routine-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; background: #f5f5f5; color: #666; font-size: 11px; line-height: 18px; white-space: nowrap; }
      `}</style>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{t('viewTitle.routines')}</span>
            <Space>
              <Button icon={<ImportOutlined />} onClick={() => {
                setExtractTarget(null)
                setExtractOpen(true)
                void window.electronAPI.listConversations().then((list) => {
                  setConversations(list.map((c) => ({ id: c.id, title: c.title })))
                }).catch(() => {})
              }}>
                从对话提取
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                新建任务
              </Button>
            </Space>
          </div>

          {routines.length === 0 && (
            <div style={{ color: '#999', padding: '32px 0', fontSize: 13 }}>
              还没有日常工作。新建一个提示词任务，或从一段对话中提炼；可以立即执行，也可以设定每天/每周等固定时间自动跑。
            </div>
          )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {routines.map((routine) => {
          const scheduleText = routine.enabled && routine.schedule
            ? `下次运行：${describeCron(routine.schedule.cron)}`
            : routine.enabled ? '手动执行' : '已停用'
          const lastRun = lastRunByRoutine.get(routine.id)
          const lastRunText = lastRun
            ? `${RUN_STATUS_TAG[lastRun.status].text} · ${describeRelativeTimeText(lastRun.startedAt, runsFetchedAt, t) ?? ''}`
            : null
          const description = routine.description || (routine.prompt ? `提示词：${routine.prompt}` : '')
          const projectName = routine.projectId && routine.projectId !== 'default'
            ? projects.find((p) => p.id === routine.projectId)?.name ?? routine.projectId
            : null
          return (
            <div
              key={routine.id}
              className="routine-card"
              style={{ display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid #f0f0f0', padding: '14px 16px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {routine.name}
                </span>
                {routine.schedule?.cron && checkCron(routine.schedule.cron).valid && <Tag color="black">定时</Tag>}
                {projectName && <Tag>{projectName}</Tag>}
              </div>
              <div
                title={description}
                style={{
                  fontSize: 12, color: '#888', marginTop: 6, minHeight: 36,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}
              >
                {description}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                <span className="routine-pill"><ClockCircleOutlined />{scheduleText}</span>
                {lastRunText && <span className="routine-pill">{lastRunText}</span>}
                {(routine.params?.length ?? 0) > 0 && (
                  <span className="routine-pill">参数 {routine.params!.map((p) => p.key).join(' · ')}</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 10, paddingTop: 10, borderTop: '1px solid #f5f5f5' }}>
                <Switch
                  size="small"
                  checked={routine.enabled}
                  onChange={(checked) => void window.electronAPI.routineToggle(routine.id, checked).then(reload)}
                />
                <span style={{ flex: 1 }} />
                <Tooltip title="立即运行">
                  <Button type="text" icon={<PlayCircleOutlined style={{ fontSize: 17 }} />} onClick={() => void runNow(routine)} />
                </Tooltip>
                <Tooltip title="运行历史">
                  <Button type="text" icon={<HistoryOutlined style={{ fontSize: 16 }} />} onClick={() => setHistoryOfId(routine.id)} />
                </Tooltip>
                <Tooltip title="编辑">
                  <Button type="text" icon={<EditOutlined style={{ fontSize: 15 }} />} onClick={() => openEditor(routine)} />
                </Tooltip>
                <Tooltip title="删除">
                  <Button type="text" danger icon={<DeleteOutlined style={{ fontSize: 15 }} />} onClick={() => removeRoutine(routine)} />
                </Tooltip>
              </div>
            </div>
          )
        })}
      </div>
        </div>
      )}

      {/* Editor */}
      <Drawer
        title={draft?.id ? '编辑任务' : '新建任务'}
        open={draft != null}
        onClose={() => setDraft(null)}
        width={560}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button onClick={() => setDraft(null)} style={{ marginInlineEnd: 8 }}>取消</Button>
            <Button type="primary" disabled={!draft?.name.trim() || !draft?.prompt.trim()} onClick={() => void saveDraft()}>保存</Button>
          </div>
        }
      >
        {draft && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>任务名称</div>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：每日依赖巡检" autoFocus />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>描述（可选）</div>
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>提示词（独立可执行；用 {'{{参数名}}'} 引用参数）</div>
              <Input.TextArea
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                rows={8}
                placeholder="例如：检查 {{repo}} 仓库的依赖是否有已知安全漏洞，输出报告。"
              />
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>参数（可选）</div>
              {draft.params.map((p, i) => (
                <Space key={i} style={{ display: 'flex', marginBottom: 6 }}>
                  <Input style={{ width: 110 }} value={p.key} placeholder="参数名" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, key: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Input style={{ width: 120 }} value={p.label} placeholder="显示名" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, label: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Input style={{ width: 140 }} value={p.default} placeholder="默认值" onChange={(e) => {
                    const params = [...draft.params]; params[i] = { ...p, default: e.target.value }; setDraft({ ...draft, params })
                  }} />
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setDraft({ ...draft, params: draft.params.filter((_, j) => j !== i) })} />
                </Space>
              ))}
              <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={() => setDraft({ ...draft, params: [...draft.params, { key: '', label: '' }] })}>
                添加参数
              </Button>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13 }}>定时执行</span>
                <Switch size="small" checked={draft.scheduleEnabled} onChange={(scheduleEnabled) => setDraft({ ...draft, scheduleEnabled })} />
              </div>
              {draft.scheduleEnabled && (
                <>
                  <Select
                    style={{ width: '100%' }}
                    value={draft.sched.kind}
                    onChange={(kind) => setDraft({
                      ...draft,
                      sched: kind === 'custom'
                        ? { kind: 'custom', cron: draft.sched.kind === 'custom' ? draft.sched.cron : '0 9 * * *' }
                        : { ...SCHED_DEFAULTS[kind], ...(('time' in draft.sched) ? { time: draft.sched.time } : {}) },
                    })}
                    options={SCHEDULE_MODES}
                  />
                  {draft.sched.kind === 'daily' && <DailyScheduleRow sched={draft.sched} onChange={(sched) => setDraft({ ...draft, sched })} />}
                  {draft.sched.kind === 'weekly' && <WeeklyScheduleRow sched={draft.sched} onChange={(sched) => setDraft({ ...draft, sched })} />}
                  {draft.sched.kind === 'monthly' && <MonthlyScheduleRow sched={draft.sched} onChange={(sched) => setDraft({ ...draft, sched })} />}
                  {draft.sched.kind === 'interval' && <IntervalScheduleRow sched={draft.sched} onChange={(sched) => setDraft({ ...draft, sched })} />}
                  {draft.sched.kind === 'custom' && <CustomScheduleRow sched={draft.sched} onChange={(sched) => setDraft({ ...draft, sched })} />}
                  <div style={{ fontSize: 11, marginTop: 6, color: cronCheck && !cronCheck.valid ? '#cf1322' : '#999' }}>
                    {scheduleHint()}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div style={{ marginBottom: 6, fontSize: 13 }}>错过计划时（应用没开着）</div>
                    <Select
                      value={draft.catchUp}
                      onChange={(catchUp) => setDraft({ ...draft, catchUp })}
                      options={[
                        { value: 'once', label: '打开应用后补跑一次' },
                        { value: 'skip', label: '跳过，等下一个计划点' },
                      ]}
                      style={{ width: 240 }}
                    />
                  </div>
                </>
              )}
            </div>
            <div>
              <div style={{ marginBottom: 6, fontSize: 13 }}>执行项目（决定工作区与沙箱）</div>
              <Select
                allowClear
                value={draft.projectId}
                onChange={(projectId) => setDraft({ ...draft, projectId })}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                placeholder="默认项目"
                style={{ width: 280 }}
              />
            </div>
          </div>
        )}
      </Drawer>

      {/* Extract-from-conversation picker */}
      <Modal
        title="从对话提取日常工作"
        open={extractOpen}
        onCancel={() => setExtractOpen(false)}
        onOk={() => void extractFromConversation()}
        okText={extracting ? '提取中…' : '提取'}
        okButtonProps={{ disabled: !extractTarget, icon: extracting ? <LoadingOutlined /> : undefined }}
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflow: 'auto' }}>
          {conversations.length === 0 && <div style={{ color: '#999' }}>没有可提取的对话。</div>}
          {conversations.map((conv) => (
            <div
              key={conv.id}
              onClick={() => setExtractTarget(conv.id)}
              style={{
                padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                border: extractTarget === conv.id ? '1px solid #333' : '1px solid #f0f0f0',
                background: extractTarget === conv.id ? 'rgba(0,0,0,0.04)' : 'transparent',
              }}
            >
              {conv.title}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}

export default RoutineCenter
