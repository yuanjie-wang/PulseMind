import { describe, it, expect } from 'vitest'
import {
  assistConversationId,
  buildFormAnnotation,
  buildAssistSystemPrompt,
  parseRoutineDraftBlock,
} from '../src/renderer/src/components/routine/routine-assist'
import {
  applyAssistantDraft,
  draftScheduleFromCron,
  draftToRoutineInput,
  EMPTY_DRAFT,
  routineToDraft,
  validateDraft,
} from '../src/renderer/src/components/routine/routine-form-model'

describe('assistConversationId', () => {
  it('keys on the routine id and buckets unsaved drafts', () => {
    expect(assistConversationId('r1')).toBe('routine_assist_r1')
    expect(assistConversationId(null)).toBe('routine_assist_draft')
  })
})

describe('buildFormAnnotation', () => {
  it('appends the live form state as a trailing block', () => {
    const annotation = buildFormAnnotation({
      name: '巡检', description: '', prompt: '检查 {{repo}}', scheduleEnabled: true,
      cron: '0 9 * * *', catchUp: 'once', enabled: true, params: [{ key: 'repo', label: '仓库' }],
    })
    expect(annotation).toContain('[当前表单]')
    expect(annotation).toContain('"cron":"0 9 * * *"')
    expect(annotation).toContain('{{repo}}')
  })
})

describe('buildAssistSystemPrompt', () => {
  it('pins the routine-draft output protocol', () => {
    const prompt = buildAssistSystemPrompt()
    expect(prompt).toContain('routine-draft')
    expect(prompt).toContain('[当前表单]')
    expect(prompt).toContain('{{参数名}}')
  })
})

describe('parseRoutineDraftBlock', () => {
  it('returns null when there is no fence', () => {
    expect(parseRoutineDraftBlock('普通回复，没有草稿。')).toBeNull()
    expect(parseRoutineDraftBlock('```json\n{"name":"x"}\n```')).toBeNull()
  })

  it('parses the last routine-draft fence', () => {
    const reply = [
      '帮你设计了任务：',
      '```routine-draft',
      '{"name":"每日巡检","description":"检查依赖","prompt":"检查 {{repo}} 的漏洞","cron":"0 9 * * *","params":[{"key":"repo","label":"仓库","default":"a/b"}]}',
      '```',
    ].join('\n')
    expect(parseRoutineDraftBlock(reply)).toEqual({
      name: '每日巡检',
      description: '检查依赖',
      prompt: '检查 {{repo}} 的漏洞',
      cron: '0 9 * * *',
      params: [{ key: 'repo', label: '仓库', default: 'a/b' }],
    })
  })

  it('keeps only the last fence when the reply has several', () => {
    const reply = [
      '```routine-draft\n{"name":"第一版"}\n```',
      '改一下：',
      '```routine-draft\n{"name":"第二版"}\n```',
    ].join('\n')
    expect(parseRoutineDraftBlock(reply)?.name).toBe('第二版')
  })

  it('drops malformed or empty drafts', () => {
    expect(parseRoutineDraftBlock('```routine-draft\nnot json\n```')).toBeNull()
    expect(parseRoutineDraftBlock('```routine-draft\n{}\n```')).toBeNull()
    expect(parseRoutineDraftBlock('```routine-draft\n{"name":"x","params":[{"label":"缺 key"}]}\n```')?.name).toBe('x')
  })
})

describe('applyAssistantDraft', () => {
  it('overwrites only the carried fields', () => {
    const current = { ...EMPTY_DRAFT, name: '旧名字', prompt: '旧提示词', description: '旧描述' }
    const next = applyAssistantDraft({ name: '新任务', prompt: '新提示词' }, current)
    expect(next.name).toBe('新任务')
    expect(next.prompt).toBe('新提示词')
    expect(next.description).toBe('旧描述')
    expect(next.scheduleEnabled).toBe(false)
  })

  it('never blanks name or prompt', () => {
    const current = { ...EMPTY_DRAFT, name: '保留', prompt: '保留词' }
    const next = applyAssistantDraft({ name: '', prompt: '   ' }, current)
    expect(next.name).toBe('保留')
    expect(next.prompt).toBe('保留词')
  })

  it('routes the proposed cron through the friendly schedule fields', () => {
    const next = applyAssistantDraft({ name: 'x', cron: '30 9 * * *' }, EMPTY_DRAFT)
    expect(next.scheduleEnabled).toBe(true)
    expect(next.sched).toEqual({ kind: 'daily', time: '09:30' })
    expect(draftScheduleFromCron('30 9 * * *').sched).toEqual(next.sched)
  })

  it('replaces params as a whole when provided', () => {
    const current = { ...EMPTY_DRAFT, params: [{ key: 'old', label: '旧' }] }
    const next = applyAssistantDraft({ name: 'x', params: [{ key: 'repo', label: '' }] }, current)
    expect(next.params).toEqual([{ key: 'repo', label: 'repo' }])
  })
})

describe('validateDraft + draftToRoutineInput', () => {
  it('rejects an invalid custom cron and empty weekday picks', () => {
    expect(validateDraft({ ...EMPTY_DRAFT, scheduleEnabled: true, sched: { kind: 'custom', cron: 'nope' } })).toBe('cron 表达式无效')
    expect(validateDraft({ ...EMPTY_DRAFT, scheduleEnabled: true, sched: { kind: 'weekly', weekdays: [], time: '09:00' } })).toBe('请至少选择一个星期')
    expect(validateDraft(EMPTY_DRAFT)).toBeNull()
  })

  it('assembles the IPC payload with schedule only when enabled', () => {
    const scheduled = draftToRoutineInput({ ...EMPTY_DRAFT, name: ' 巡检 ', prompt: 'p', scheduleEnabled: true, sched: { kind: 'daily', time: '09:00' } })
    expect(scheduled.name).toBe('巡检')
    expect(scheduled.schedule).toEqual({ cron: '0 9 * * *', catchUp: 'once' })
    expect(draftToRoutineInput(EMPTY_DRAFT).schedule).toBeUndefined()
  })
})

describe('routineToDraft round-trip', () => {
  it('unparseable crons survive through the custom editor', () => {
    const draft = routineToDraft({
      id: 'r1', name: 'n', description: '', prompt: 'p', enabled: true, createdAt: '', updatedAt: '',
      params: [{ key: 'k', label: 'K' }],
      schedule: { cron: '0 9-17 * * *', catchUp: 'skip' },
    })
    expect(draft.scheduleEnabled).toBe(true)
    expect(draft.sched).toEqual({ kind: 'custom', cron: '0 9-17 * * *' })
    expect(draft.catchUp).toBe('skip')
    expect(draft.params).toEqual([{ key: 'k', label: 'K' }])
  })
})
