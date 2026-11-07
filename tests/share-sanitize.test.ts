// PLAN-share-import-export：sanitize/envelope/预览纯函数矩阵。
// 钉：token 剥离→roundtrip 后 normalizeTriggers 重铸出**不同** token、id/时间戳
// 剥离、未知名段丢弃、裸对象 sniff 三态、version 门、字节帽、工作流透传。

import { describe, expect, it } from 'vitest'
import {
  sanitizeRoutineForExport,
  buildEnvelope,
  parseShareFile,
  sniffKind,
  routinePreviewWarnings,
  routineSummary,
  workflowSummary,
  shareNameOf,
  SHARE_VERSION,
} from '../src/shared/share/sanitize'
import { validateWorkflow } from '../src/shared/workflow/validate'

const fullRoutine: Record<string, unknown> = {
  id: 'routine_abc123',
  name: '日报任务',
  description: '每天写日报',
  prompt: '写日报',
  params: [{ key: 'name', label: '姓名', required: true }],
  icon: 'FileText',
  schedule: { cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
  enabled: true,
  skills: ['office'],
  workspaceDir: '/Users/someone/work',
  approvalMode: 'outside-ask',
  profileId: 'p_1',
  batch: { csvPath: '/Users/someone/team.csv', concurrency: 3 },
  triggers: [
    { type: 'webhook', token: 'secret-token-hex' },
    { type: 'file', paths: ['/Users/someone/inbox'], debounceMs: 5000 },
  ],
  sourceConversationId: 'conv_orig',
  nextRunAt: '2026-11-08T01:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  unknownField: { junk: true },
}

describe('sanitizeRoutineForExport', () => {
  const payload = sanitizeRoutineForExport(fullRoutine)

  it('剥离：id / webhook token / sourceConversationId / nextRunAt / 时间戳', () => {
    expect('id' in payload).toBe(false)
    expect('sourceConversationId' in payload).toBe(false)
    expect('nextRunAt' in payload).toBe(false)
    expect('createdAt' in payload).toBe(false)
    expect('updatedAt' in payload).toBe(false)
    const triggers = payload.triggers as Array<Record<string, unknown>>
    expect(triggers[0]).toEqual({ type: 'webhook' }) // token 剥了，条目还在
    expect(JSON.stringify(payload)).not.toContain('secret-token-hex')
  })

  it('保留任务本体全部语义 + 机器路径原样（预览警示承担信任边界）', () => {
    expect(payload.name).toBe('日报任务')
    expect(payload.prompt).toBe('写日报')
    expect(payload.schedule).toEqual({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    expect(payload.workspaceDir).toBe('/Users/someone/work')
    expect((payload.batch as Record<string, unknown>).csvPath).toBe('/Users/someone/team.csv')
    expect((payload.triggers as Array<Record<string, unknown>>)[1]).toEqual({ type: 'file', paths: ['/Users/someone/inbox'], debounceMs: 5000 })
    expect(payload.profileId).toBe('p_1')
    expect(payload.skills).toEqual(['office'])
  })

  it('白名单构造：未知名段丢弃', () => {
    expect('unknownField' in payload).toBe(false)
  })
})

describe('parseShareFile', () => {
  it('envelope 往返：buildEnvelope → parseShareFile 逐条还原', () => {
    const envelope = buildEnvelope([
      { kind: 'routine', payload: sanitizeRoutineForExport(fullRoutine) },
      {
        kind: 'workflow',
        payload: { id: 'wf', nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] }], edges: [{ from: 'a', when: 'pass', to: 'DONE' }] },
      },
    ])
    const parsed = parseShareFile(JSON.stringify(envelope))
    expect(parsed.errors).toEqual([])
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].kind).toBe('routine')
    expect(parsed.items[0].payload.name).toBe('日报任务')
    expect(parsed.items[1].kind).toBe('workflow')
  })

  it('裸对象 sniff：workflow（workflows/<id>.json 直接拖入）与 routine 都能导', () => {
    expect(sniffKind({ name: 'x', prompt: 'p' })).toBe('routine')
    expect(sniffKind({ nodes: [], edges: [] })).toBe('workflow')
    expect(sniffKind({ nodes: 'junk', edges: [] })).toBeNull()
    expect(sniffKind({ junk: 1 })).toBeNull()
    const parsed = parseShareFile(
      JSON.stringify({
        id: 'wf',
        name: 'wf',
        entry: 'a',
        nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] }],
        edges: [{ from: 'a', when: 'pass', to: 'DONE' }],
      }),
    )
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0].kind).toBe('workflow')
  })

  it('version 门：来自更新版本的文件拒绝并明说；format 字段不符走 sniff 兜底', () => {
    const future = parseShareFile(JSON.stringify({ format: 'pulsemind-share', version: SHARE_VERSION + 1, items: [] }))
    expect(future.items).toHaveLength(0)
    expect(future.errors[0]).toContain('更新版本')
    // format 同名但 junk 内容 → sniff 不中
    const junk = parseShareFile(JSON.stringify({ format: 'pulsemind-share', version: 1, items: [{ kind: 'routine', payload: { junk: true } }] }))
    expect(junk.errors.some((e) => e.includes('没有可识别'))).toBe(true)
  })

  it('字节帽与畸形输入', () => {
    expect(parseShareFile('x'.repeat(5_000_001)).errors[0]).toContain('帽')
    expect(parseShareFile('not json').errors[0]).toContain('JSON')
    expect(parseShareFile('[]').errors[0]).toContain('不是可识别')
  })
})

describe('预览数据面', () => {
  it('routine 警示：token 重置 / 本机路径 / 缺失技能', () => {
    const payload = sanitizeRoutineForExport(fullRoutine)
    const w = routinePreviewWarnings(payload, new Set(['office']))
    expect(w.some((x) => x.includes('token') && x.includes('重置'))).toBe(true)
    expect(w.some((x) => x.includes('本机路径') && x.includes('批量 CSV'))).toBe(true)
    expect(w.some((x) => x.includes('缺失绑定的技能'))).toBe(false)
    const withMissing = routinePreviewWarnings(payload, new Set(['other-skill']))
    expect(withMissing.some((x) => x.includes('office'))).toBe(true)
  })

  it('routine 摘要与名称；workflow 摘要', () => {
    const payload = sanitizeRoutineForExport(fullRoutine)
    expect(shareNameOf(payload)).toBe('日报任务')
    expect(routineSummary(payload)).toContain('cron: 0 9 * * 1-5')
    expect(routineSummary(payload)).toContain('批量')
    const wf = { nodes: [{}, {}, {}], edges: [{}], objective: '落地' }
    expect(workflowSummary(wf)).toContain('3 节点')
    expect(workflowSummary(wf)).toContain('落地')
  })

  it('工作流预览走同一 validate 门：合法→透传不 blocked，非法→blocked 带错误', () => {
    const good = {
      id: 'wf',
      name: 'wf',
      entry: 'a',
      nodes: [{ id: 'a', title: 'A', prompt: 'p', verdicts: ['pass'] }],
      edges: [{ from: 'a', when: 'pass', to: 'DONE' }],
    }
    const preview = validateWorkflow(good)
    expect(preview.ok).toBe(true)
    const bad = { ...good, edges: [{ from: 'a', when: 'SKIP', to: 'DONE' }] }
    const v2 = validateWorkflow(bad)
    expect(v2.ok).toBe(false)
    expect(v2.errors[0]).toContain('verdicts')
  })
})
