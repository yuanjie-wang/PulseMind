import { describe, it, expect } from 'vitest'
import {
  buildFormAssistSystemPrompt,
  buildFormAnnotation,
  formAssistConversationId,
  parseFormPatch,
} from '../src/renderer/src/components/form-assist/form-assist'
import { ROUTINE_ASSIST_SPEC } from '../src/renderer/src/components/routine/routine-assist'
import {
  applyAssistantPatch,
  draftScheduleFromCron,
  draftToRoutineInput,
  EMPTY_DRAFT,
  routineToDraft,
  validateDraft,
} from '../src/renderer/src/components/routine/routine-form-model'

describe('assist conversation id', () => {
  it('keys on the routine id and buckets unsaved drafts', () => {
    expect(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, 'r1')).toBe('routine_assist_r1')
    expect(formAssistConversationId(ROUTINE_ASSIST_SPEC.conversationPrefix, null)).toBe('routine_assist_draft')
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

describe('buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC)', () => {
  it('pins the form-patch output protocol', () => {
    const prompt = buildFormAssistSystemPrompt(ROUTINE_ASSIST_SPEC)
    expect(prompt).toContain('form-patch')
    expect(prompt).toContain('[当前表单]')
    expect(prompt).toContain('{{参数名}}')
  })
})

describe('parseFormPatch with ROUTINE_ASSIST_SPEC', () => {
  it('returns null when there is no proposal fence', () => {
    expect(parseFormPatch('普通回复，没有草稿。', ROUTINE_ASSIST_SPEC)).toBeNull()
  })

  it('parses the last form-patch fence', () => {
    const reply = [
      '帮你设计了任务：',
      '```form-patch',
      '{"name":"每日巡检","prompt":"检查 {{repo}} 的漏洞","cron":"0 9 * * *","params":[{"key":"repo","label":"仓库","default":"a/b"}]}',
      '```',
    ].join('\n')
    expect(parseFormPatch(reply, ROUTINE_ASSIST_SPEC)).toEqual({
      name: '每日巡检',
      prompt: '检查 {{repo}} 的漏洞',
      cron: '0 9 * * *',
      params: [{ key: 'repo', label: '仓库', default: 'a/b' }],
    })
  })

  it('still parses the legacy routine-draft fence from old transcripts', () => {
    const reply = [
      '帮你设计了任务：',
      '```routine-draft',
      '{"name":"每日巡检","description":"检查依赖"}',
      '```',
    ].join('\n')
    expect(parseFormPatch(reply, ROUTINE_ASSIST_SPEC)).toEqual({ name: '每日巡检', description: '检查依赖' })
  })

  it('keeps only the last fence when the reply has several', () => {
    const reply = [
      '```form-patch\n{"name":"第一版"}\n```',
      '改一下：',
      '```form-patch\n{"name":"第二版"}\n```',
    ].join('\n')
    expect(parseFormPatch(reply, ROUTINE_ASSIST_SPEC)?.name).toBe('第二版')
  })

  it('drops malformed or empty drafts', () => {
    expect(parseFormPatch('```form-patch\nnot json\n```', ROUTINE_ASSIST_SPEC)).toBeNull()
    expect(parseFormPatch('```form-patch\n{}\n```', ROUTINE_ASSIST_SPEC)).toBeNull()
    expect(parseFormPatch('```form-patch\n{"name":"x","params":[{"label":"缺 key"}]}\n```', ROUTINE_ASSIST_SPEC)?.name).toBe('x')
  })
})

describe('applyAssistantPatch', () => {
  it('overwrites only the carried fields', () => {
    const current = { ...EMPTY_DRAFT, name: '旧名字', prompt: '旧提示词', description: '旧描述' }
    const next = applyAssistantPatch({ name: '新任务', prompt: '新提示词' }, current)
    expect(next.name).toBe('新任务')
    expect(next.prompt).toBe('新提示词')
    expect(next.description).toBe('旧描述')
    expect(next.scheduleEnabled).toBe(false)
  })

  it('never blanks name or prompt', () => {
    const current = { ...EMPTY_DRAFT, name: '保留', prompt: '保留词' }
    const next = applyAssistantPatch({ name: '', prompt: '   ' }, current)
    expect(next.name).toBe('保留')
    expect(next.prompt).toBe('保留词')
  })

  it('routes the proposed cron through the friendly schedule fields', () => {
    const next = applyAssistantPatch({ name: 'x', cron: '30 9 * * *' }, EMPTY_DRAFT)
    expect(next.scheduleEnabled).toBe(true)
    expect(next.sched).toEqual({ kind: 'daily', time: '09:30' })
    expect(draftScheduleFromCron('30 9 * * *').sched).toEqual(next.sched)
  })

  it('replaces params as a whole when provided', () => {
    const current = { ...EMPTY_DRAFT, params: [{ key: 'old', label: '旧' }] }
    const next = applyAssistantPatch({ name: 'x', params: [{ key: 'repo', label: '' }] }, current)
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
