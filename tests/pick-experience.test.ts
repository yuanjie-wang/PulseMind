import { describe, it, expect, afterEach } from 'vitest'
import { ToolExecutor, resetExperienceCandidateCache } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { AgentEngineOptions } from '../src/renderer/src/agent/types'
import type { ToolUseBlock } from '../src/shared/types/agent'
import type { SkillDefinition } from '../src/shared/types/skill-types'
import type { MemoryPageRecord } from '../src/shared/memory-pages'

/**
 * pick_skill 拉取经验（PLAN-experience-sop B，裁定二：一阶段产出即可拉）。
 * 钉住的契约：
 *  - 候选表在已启用技能之外含 `[experience]` 行（帽 30）；
 *  - 解析序即判词：同名时已安装技能赢，注册表未命中才解析经验页（title → alias）；
 *  - 经验信封无 **Location:** 行（无磁盘文件），脚本反向序列化回围栏，尾行数据指针；
 *  - 白名单不拦经验（progressive disclosure：只读知识无需授权）；
 *  - 选中成功 touch use_count（有意图的拉取才记账）。
 */

const REGISTRY_DEF: SkillDefinition = {
  name: 'deployer', description: 'installed skill', category: 'probe', systemPrompt: 'SKILL BODY',
}

const cluePage: MemoryPageRecord = {
  id: 'page_clue', title: '手工部署八步', type: 'experience', summary: '发布流程的教训',
  body: '## 背景\n每次发布都手动走八步。', aliases: ['deploy'], links: [],
  supersededBy: null, sourceConversationId: 'conv_20261001', files: null,
  useCount: 0, lastUsedAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  maturity: 'clue', recurrence: 2, lastReinforcedAt: '2026-10-20T00:00:00.000Z',
  sopAttempts: 0, sopLastAttemptAt: null,
  retiredAt: null, retireReason: null,
  enabled: true,
}
const sopPage: MemoryPageRecord = {
  ...cluePage,
  id: 'page_sop', title: '部署SOP', body: '## 背景\n部署流程 v2。', aliases: [],
  sourceConversationId: 'conv_20261010', updatedAt: '2026-10-10T00:00:00.000Z',
  files: [{ path: 'scripts/deploy.mjs', content: 'console.log("deploy")' }],
  maturity: 'sop',
}

interface PickOutcome { content: string; isError?: boolean }

/** 技能侧记账（2026-10-27）：选中已注册技能 → recordSkillUse(name)；经验不走它。 */
const skillTouches: string[] = []

function runPick(
  input: Record<string, unknown>,
  pages: MemoryPageRecord[],
  selectionAgent?: { execute: (input: unknown, opts: unknown) => Promise<string> },
  opts: { allowedSkills?: string[]; skill?: boolean } = {},
  touched: string[] = []
) {
  const seen: PickOutcome[] = []
  const host = {
    listMemoryPages: async (type?: string) => (type === 'experience' ? pages : []),
    // 经验真源已改磁盘（2026-11-12）：pick_skill 走这一条，不再从 listMemoryPages 取。
    listExperienceFiles: async () => pages,
    touchMemoryPage: async (id: string) => { touched.push(id) },
    recordSkillUse: async (name: string) => { skillTouches.push(name) },
    installSkill: async () => null,
  }
  setHost(host as unknown as PulseHost)
  const skillManagerStub = {
    getSkill: (name: string) => (opts.skill && name === 'deployer' ? { definition: REGISTRY_DEF, enabled: true } : undefined),
    getEnabledSkills: () => (opts.skill ? [{ definition: REGISTRY_DEF, enabled: true }] : []),
  }
  const t = { id: 't1', name: 'pick_skill', input } as unknown as ToolUseBlock
  const ex = new ToolExecutor(
    { conversationId: 'conv_1', skillsDir: '/data/skills', skillManager: skillManagerStub, allowedSkills: opts.allowedSkills } as unknown as AgentEngineOptions,
    new Map(),
    null as never,
    (selectionAgent ?? null) as never,
    (_id: string, content: string, isError?: boolean) => seen.push({ content, isError }),
    () => {}
  )
  return ex.execPickSkill(t).then(() => seen[0])
}

afterEach(() => {
  skillTouches.length = 0
  resetExperienceCandidateCache()
  setHost(null as unknown as PulseHost)
})

describe('名字分支：注册表未命中 → 经验页', () => {
  it('按 title 命中：信封无 Location、带正文与数据指针尾行，且 touch 记账', async () => {
    const touched: string[] = []
    const out = await runPick({ name: '手工部署八步' }, [cluePage], undefined, {}, touched)
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 手工部署八步')
    expect(out?.content).toContain('每次发布都手动走八步')
    expect(out?.content).not.toContain('**Location:**')
    expect(out?.content).toContain('(source: conv_20261001, extracted 2026-10-01, maturity: clue)')
    expect(touched).toEqual(['page_clue'])
  })

  it('按 alias 命中（deploy → 手工部署八步）', async () => {
    const out = await runPick({ name: 'deploy' }, [cluePage])
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 手工部署八步')
  })

  it('SOP 页的信封带脚本围栏', async () => {
    const out = await runPick({ name: '部署SOP' }, [sopPage])
    expect(out?.content).toContain('### File: scripts/deploy.mjs')
    expect(out?.content).toContain('maturity: sop')
  })

  it('解析序即判词：同名时已安装技能赢，不 touch', async () => {
    const touched: string[] = []
    const collision: MemoryPageRecord = { ...cluePage, title: 'deployer' }
    const out = await runPick({ name: 'deployer' }, [collision], undefined, { skill: true }, touched)
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Selected Skill: deployer')
    expect(out?.content).toContain('SKILL BODY')
    expect(touched).toEqual([])
    // 技能侧的记账走 recordSkillUse（不 await——等一拍让微任务落地）
    await new Promise((r) => setTimeout(r, 0))
    expect(skillTouches).toEqual(['deployer'])
  })

  it('选中经验不记技能计数；技能计数失败不影响信封', async () => {
    const out = await runPick({ name: '手工部署八步' }, [cluePage])
    expect(out?.isError).toBeFalsy()
    await new Promise((r) => setTimeout(r, 0))
    expect(skillTouches).toEqual([])
  })

  it('都不命中 → not found 报错', async () => {
    const out = await runPick({ name: '不存在' }, [cluePage])
    expect(out?.isError).toBeTruthy()
    expect(out?.content).toContain('not found')
  })

  it('第 31 条及以后仍可按名命中（帽已移除，2026-11-12 裁定：面板所见全部可读）', async () => {
    const many: MemoryPageRecord[] = Array.from({ length: 66 }, (_, i) => ({
      ...cluePage, id: `p${i}`, title: `经验${i}`, aliases: i === 65 ? ['第六十五条'] : [],
    }))
    const touched: string[] = []
    const byTitle = await runPick({ name: '经验65' }, many, undefined, {}, touched)
    expect(byTitle?.isError).toBeFalsy()
    expect(byTitle?.content).toContain('## Experience: 经验65')
    expect(touched).toEqual(['p65'])
    // 尾页的 alias 同样可达——查找面整体不截断，不是只抬高了 title 命中
    const byAlias = await runPick({ name: '第六十五条' }, many)
    expect(byAlias?.isError).toBeFalsy()
    expect(byAlias?.content).toContain('## Experience: 经验65')
  })
})

describe('意图分支：候选表扩源', () => {
  it('候选表含 [experience] 行；选中经验 title → 经验信封 + touch', async () => {
    const touched: string[] = []
    let capturedList = ''
    const out = await runPick(
      { intent: '怎么部署' },
      [cluePage, sopPage],
      { execute: async (input) => { capturedList = (input as { skillsList: string }).skillsList; return '手工部署八步' } },
      { skill: true },
      touched
    )
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 手工部署八步')
    expect(capturedList).toContain('- deployer: installed skill (probe)')
    expect(capturedList).toContain('- [experience] 手工部署八步')
    expect(capturedList).toContain('- [experience] 部署SOP')
    expect(touched).toEqual(['page_clue'])
  })

  it('白名单不拦经验选中（progressive disclosure）', async () => {
    const out = await runPick(
      { intent: '部署' },
      [cluePage],
      { execute: async () => '手工部署八步' },
      { allowedSkills: ['deployer'], skill: true }
    )
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 手工部署八步')
  })

  it('候选表全量（帽已移除：面板所见经验全部进候选表，2026-11-12 裁定）', async () => {
    const many: MemoryPageRecord[] = Array.from({ length: 65 }, (_, i) => ({ ...cluePage, id: `p${i}`, title: `经验${i}`, aliases: [] }))
    let capturedList = ''
    await runPick(
      { intent: 'x' },
      many,
      { execute: async (input) => { capturedList = (input as { skillsList: string }).skillsList; return 'none' } }
    )
    expect(capturedList.split('- [experience] ')).toHaveLength(66) // 65 行 + 首段
  })

  it('技能与经验双空 → No skills or experiences available.', async () => {
    const out = await runPick({ intent: 'x' }, [])
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('No skills or experiences available.')
  })
})

describe('经验开关（2026-10-27，镜像技能的 enabled 语义）', () => {
  const disabledSop: MemoryPageRecord = { ...sopPage, enabled: false }

  it('停用页不进意图候选表（getEnabledSkills 同款），启用页照常在', async () => {
    let capturedList = ''
    await runPick(
      { intent: '怎么部署' },
      [cluePage, disabledSop],
      { execute: async (input) => { capturedList = (input as { skillsList: string }).skillsList; return '手工部署八步' } }
    )
    expect(capturedList).toContain('- [experience] 手工部署八步')
    expect(capturedList).not.toContain('- [experience] 部署SOP')
  })

  it('显式按名拉取停用页仍可解析（getSkill 对停用技能的同款行为）', async () => {
    const out = await runPick({ name: '部署SOP' }, [disabledSop])
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 部署SOP')
  })

  it('全部停用 → 候选表只剩技能；无技能时报双空', async () => {
    const out = await runPick({ intent: 'x' }, [{ ...cluePage, enabled: false }])
    expect(out?.content).toContain('No skills or experiences available.')
  })
})

describe('退役页（2026-10-27，compile pass retire op 的消费面排除）', () => {
  const retired: MemoryPageRecord = { ...cluePage, retiredAt: '2026-10-27T00:00:00.000Z', retireReason: '内容已过时' }

  it('退役页不进意图候选表（isLivePage 同款排除，与开关独立）', async () => {
    let capturedList = ''
    await runPick(
      { intent: '怎么部署' },
      [cluePage, retired],
      { execute: async (input) => { capturedList = (input as { skillsList: string }).skillsList; return 'none' } }
    )
    // 活页恰好在一次，退役页不在
    expect(capturedList.split('- [experience] 手工部署八步')).toHaveLength(2)
  })

  it('按名拉取退役页 → not found（与停用相对：退役 = 彻底退出池子，恢复是唯一回路）', async () => {
    const out = await runPick({ name: '手工部署八步' }, [retired])
    expect(out?.isError).toBeTruthy()
    expect(out?.content).toContain('not found')
  })

  it('按 alias 拉取退役页同样不解析（deploy 别名随页退役）', async () => {
    const out = await runPick({ name: 'deploy' }, [retired])
    expect(out?.isError).toBeTruthy()
  })

  it('恢复（retiredAt 清空）即回池子', async () => {
    const out = await runPick({ name: 'deploy' }, [{ ...retired, retiredAt: null, retireReason: null }])
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('## Experience: 手工部署八步')
  })
})
