import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** SOP 固化（PLAN-experience-sop 刀三）的接线扫描：真跑无人值守会话需要 LLM，
 *  运行时行为由 probe-sop-distill.mjs 的核收半边驱动真库验证；这里钉的是
 *  「链路确实接上了」——断一处，按钮就是死的且没有任何响。 */

const read = (p: string) => readFileSync(p, 'utf-8')

describe('固化链路接线', () => {
  it('IPC 通道在位', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("MEMORY_PAGE_DISTILL_SOP: 'memory-page:distill-sop'")
  })
  it('preload + bridge 类型在位', () => {
    expect(read('src/preload/index.ts')).toContain('distillSop:')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('distillSop: (pageId: string)')
  })
  it('memory.handler 注册 handler + trigger', () => {
    const src = read('src/main/ipc/memory.handler.ts')
    expect(src).toContain('IPC_CHANNELS.MEMORY_PAGE_DISTILL_SOP')
    expect(src).toContain('setSopDistillTrigger')
  })
  it('session-manager 挂载 trigger（sop-runner 托管运行）', () => {
    const src = read('src/main/agent/session-manager.ts')
    expect(src).toContain('setSopDistillTrigger((pageId) => runSopDistill(pageId))')
  })
  it('sop_ 前缀派生 routine 型（隐藏 + 清扫豁免）', () => {
    expect(read('src/main/storage/conversation.db.ts')).toContain("id.startsWith('sop_')")
  })
})

describe('刀四：自动清扫接线', () => {
  it('提取清扫尾部挂 SOP 清扫（批帽 + 在飞跳过 + 资格门）', () => {
    const src = read('src/main/agent/session-manager.ts')
    expect(src).toContain('runSopDistillSweep(experienceOn)')
    expect(src).toContain('judgeSopCandidate')
    expect(src).toContain('SOP_SWEEP_BATCH')
    expect(src).toContain('isSopDistilling')
  })
  it('失败记账挂在核收的非升格分支', () => {
    const src = read('src/main/agent/sop-runner.ts')
    expect(src).toContain("note.kind !== 'promoted')")
    expect(src).toContain('recordSopFailedAttempt(pageId)')
  })
  it('资格门纯函数 + 新列迁移在位', () => {
    expect(read('src/shared/sop-sweep.ts')).toContain('SOP_RECURRENCE_MIN')
    expect(read('src/main/storage/database.ts')).toContain('ADD COLUMN sop_attempts INTEGER NOT NULL DEFAULT 0')
  })
})

describe('固化运行的关键语义（源码锚点）', () => {
  it('授权用 auto：outside-ask 会拒 exec 层，验证门结构性死亡', () => {
    const src = read('src/main/agent/sop-runner.ts')
    expect(src).toContain("approvalMode: 'auto'")
  })
  it('验证门：verification.md 缺失/为空 = 拒绝升格', () => {
    const src = read('src/main/agent/sop-runner.ts')
    expect(src).toContain('collectDeliverables')
    expect(src).toContain('sop/verification.md')
  })
  it('结果契约在任务 prompt 与解析器两侧同形', () => {
    const src = read('src/main/agent/sop-runner.ts')
    expect(src.match(/SOP_RESULT:/g)?.length).toBeGreaterThanOrEqual(2)
  })
  it('线索手册形态对齐：一阶段按 SKILL 标准写，二阶段 prompt 明示 sop/page.md 保持同形', () => {
    expect(read('src/renderer/src/agent/one-shot-agent/SessionReviewAgent.ts')).toContain('## 适用场景')
    expect(read('src/renderer/src/agent/one-shot-agent/MemoryPageCompileAgent.ts')).toContain('KEEPS this structure')
    expect(read('src/main/agent/sop-runner.ts')).toContain('SKILL 标准写成手册形态')
  })
  it('经验卡按钮：仅 clue 态 + 有源会话指针的活页可点', () => {
    const src = read('src/renderer/src/components/knowledge/MemoryPagesPanel.tsx')
    expect(src).toContain('handleDistillSop')
    expect(src).toContain("p.maturity === 'clue'")
    expect(src).toContain('p.sourceConversationId')
  })
  it('i18n 双语键在位', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('distillSop:')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('distillSop:')
  })
})
