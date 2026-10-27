import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 经验也是技能：技能中心经验分区的查看模式与技能对齐（2026-10-26 用户裁定）。
 *  点经验卡进入与技能一致的三栏浏览器（左列表/中文件树/右预览），不再是详情
 *  Modal。真跑 UI 需要浏览器，行为由 probe-capability-cards.mjs 的经验分区
 *  驱动真实 Chromium 验证；这里钉接线——断一处，经验卡就退回弹窗形态。 */

const read = (p: string) => readFileSync(p, 'utf-8')

describe('经验浏览器接线', () => {
  it('SkillsPanel：经验卡点击进入三栏浏览器（onOpenPage → exp: 前缀 key）', () => {
    const src = read('src/renderer/src/components/settings/SkillsPanel.tsx')
    expect(src).toContain('onOpenPage={(page) => onOpen(page.id)}')
    expect(src).toContain('setViewing(experienceKey(pageId))')
    // viewing 非 null 即渲染浏览器——旧的 `visibleSkills.some(...)` 守卫会把
    // exp: key 判成失效而打回栅格。
    expect(src).toContain('if (viewing !== null)')
    expect(src).not.toMatch(/viewing && \w+\.some\(/)
  })

  it('SkillBrowser：经验与技能共用三栏——body 即 page.md，files 即 scripts/*', () => {
    const src = read('src/renderer/src/components/settings/SkillBrowser.tsx')
    expect(src).toContain("listMemoryPages('experience')")
    expect(src).toContain("EXPERIENCE_KEY_PREFIX = 'exp:'")
    // 经验的文件视图与 sop-runner 落库、pick_skill 信封同形
    // 经验正文文件与技能同名 SKILL.md（2026-10-27 用户裁定），files 还原成 scripts/*
    expect(src).toContain("'SKILL.md', ...(rec.files ?? []).map((f) => f.path)")
    expect(src).toContain("if (path === 'SKILL.md') return Promise.resolve(activeExperience.body)")
    expect(src).not.toContain("'page.md'")
    // 左列表三分区组标与网格同构（内置 / 已安装 / 经验）
    expect(src).toContain("t('skillsSection.builtIn')")
    expect(src).toContain("t('skillsSection.imported')")
    expect(src).toContain("t('skillsSection.experience')")
  })

  it('MemoryPagesBrowser：onOpenPage 分支接管卡片点击且不再挂详情 Modal', () => {
    const src = read('src/renderer/src/components/knowledge/MemoryPagesPanel.tsx')
    expect(src).toContain('onOpenPage ? onOpenPage(p) : setDetail(p)')
    expect(src).toContain('{!onOpenPage && <MemoryPageDetailModal')
  })

  it('设置面板的记忆浏览保持 Modal 形态（不传 onOpenPage）', () => {
    const src = read('src/renderer/src/components/settings/MemorySettings.tsx')
    expect(src).toContain('<MemoryPagesBrowser deletable />')
    expect(src).not.toContain('onOpenPage')
  })

  it('i18n：sopTag 双语在位（左列表 SOP 行的金标）', () => {
    expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain('sopTag:')
    expect(read('src/renderer/src/i18n/locales/en.ts')).toContain('sopTag:')
  })
})

/** 经验卡开关（2026-10-27 用户：「开关呢」）——技能卡有启用开关，经验卡同款。
 *  停用 = 不进 pick_skill 候选表、不进 state block 提示、不进 SOP 自动固化；显式按名
 *  拉取仍可解析（镜像 getSkill 对停用技能的行为）。链路断一处开关就是摆设。 */
describe('经验开关接线', () => {
  it('列 + 迁移：memory_pages.enabled 默认 1，旧行默认启用', () => {
    const src = read('src/main/storage/database.ts')
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS memory_pages \([\s\S]*?enabled\s+INTEGER NOT NULL DEFAULT 1/)
    expect(src).toContain('ALTER TABLE memory_pages ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
  })
  it('存储层：读侧显式 0 才算停用；写侧 setMemoryPageEnabled 不动 updated_at；supersede 继承开关', () => {
    const src = read('src/main/storage/memory-pages-store.ts')
    expect(src).toContain('enabled: row.enabled !== 0')
    expect(src).toContain("UPDATE memory_pages SET enabled = ? WHERE id = ?")
    expect(src).toContain('target.enabled ? 1 : 0')
  })
  it('IPC 三件 + handler', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("MEMORY_PAGE_SET_ENABLED: 'memory-page:set-enabled'")
    expect(read('src/preload/index.ts')).toContain('setMemoryPageEnabled:')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('setMemoryPageEnabled: (pageId: string, enabled: boolean)')
    expect(read('src/main/ipc/memory.handler.ts')).toContain('IPC_CHANNELS.MEMORY_PAGE_SET_ENABLED')
  })
  it('三个消费面都看开关：候选表 / state block 提示 / SOP 自动固化', () => {
    const exec = read('src/renderer/src/agent/tool-executors.ts')
    expect(exec).toContain('enabledExperiencePages')
    // 默认打开：只有显式 false 才算停用（字段缺席的旧记录不得被读成关）
    expect(exec).toContain('.filter((p) => p.enabled !== false)')
    // 活页判定可能被重构（!p.supersededBy / isLivePage(p)），只钉开关判定本身
    expect(read('src/renderer/src/agent/system-prompt-builder.ts')).toMatch(/all\.filter\(\(p\) => [^\n]*p\.enabled !== false\)/)
    expect(read('src/main/agent/session-manager.ts')).toMatch(/listMemoryPages\('experience'\)\.filter\(\(p\) => [^\n]*p\.enabled !== false\)/)
  })
  it('UI：经验卡头部 CapabilitySwitch（开关在前）+ 浏览器左列表停用标', () => {
    const panel = read('src/renderer/src/components/knowledge/MemoryPagesPanel.tsx')
    expect(panel).toContain('<CapabilitySwitch checked={p.enabled !== false}')
    expect(panel).toContain('setMemoryPageEnabled(p.id, next)')
    expect(read('src/renderer/src/components/settings/SkillBrowser.tsx')).toContain("page.enabled === false ? (")
  })
})

/** 使用次数 + 安装/提取时间（2026-10-27 用户：展示技能被使用次数，含经验；内置安装
 *  时间用 --）与经验分区标题计数。技能计数是新表 skill_uses；经验沿用 memory_pages.use_count。 */
describe('使用次数 / 安装时间 / 经验分区计数接线', () => {
  it('skill_uses 表 + store + IPC 三件 + host 方法', () => {
    expect(read('src/main/storage/database.ts')).toContain('CREATE TABLE IF NOT EXISTS skill_uses')
    const store = read('src/main/storage/skill-use-store.ts')
    expect(store).toContain('ON CONFLICT(name) DO UPDATE SET use_count = use_count + 1')
    expect(read('src/shared/ipc-channels.ts')).toContain("SKILL_USE_RECORD: 'skill-use:record'")
    expect(read('src/shared/ipc-channels.ts')).toContain("SKILL_USE_LIST: 'skill-use:list'")
    expect(read('src/preload/index.ts')).toContain('recordSkillUse:')
    expect(read('src/preload/index.ts')).toContain('listSkillUses:')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('recordSkillUse: (name: string) => Promise<void>')
    expect(read('src/renderer/src/agent/host/types.ts')).toContain("'recordSkillUse'")
    expect(read('src/main/agent/main-host.ts')).toContain('recordSkillUse: async (name) => recordSkillUse(name)')
    const handler = read('src/main/ipc/skills.handler.ts')
    expect(handler).toContain('IPC_CHANNELS.SKILL_USE_RECORD')
    expect(handler).toContain('IPC_CHANNELS.SKILL_USE_LIST')
    expect(handler).toContain('birthtimeMs')
  })
  it('pick_skill 两个技能分支都记账（名字分支 + 意图分支），不 await', () => {
    const src = read('src/renderer/src/agent/tool-executors.ts')
    expect(src.match(/touchSkillUse\(/g)?.length).toBe(3) // 定义 + 两处调用
    expect(src).toContain('touchSkillUse(skill.definition.name)')
    expect(src).toContain('touchSkillUse(cleanName)')
  })
  it('UI：技能卡与经验卡同形的元信息行；内置安装时间 --；经验分区标题计数由浏览件回报', () => {
    const panel = read('src/renderer/src/components/settings/SkillsPanel.tsx')
    expect(panel).toContain('listSkillUses()')
    expect(panel).toContain("definition.builtIn\n    ? '--'")
    expect(panel).toContain("t('skills.useCount', { count: use?.useCount ?? 0 })")
    expect(panel).toContain("sectionTitle(t('skillsSection.experience'), expCount)")
    expect(panel).toContain('onCount={setExpCount}')
    const browser = read('src/renderer/src/components/knowledge/MemoryPagesPanel.tsx')
    expect(browser).toContain('onCountRef.current?.(next.length)')
    expect(browser).toContain("t('memoryPages.useCount', { count: p.useCount })")
    expect(browser).toContain("t('memoryPages.extractedAt'")
  })
  it('i18n 双语键在位', () => {
    for (const loc of ['zh', 'en']) {
      const dict = read(`src/renderer/src/i18n/locales/${loc}.ts`)
      expect(dict).toContain('installedAt:')
      expect(dict).toContain('extractedAt:')
      expect(dict.match(/useCount:/g)?.length).toBeGreaterThanOrEqual(2) // skills + memoryPages
    }
  })
})


/** pick_skill 的三个「说明面」（2026-10-27 用户问「经验会进入 pick_skill 的工具描述吗」
 *  ——此前答案是不会，模型不知道能按名拉经验，还会按 Local Knowledge 节的旧话术去
 *  recall 找 playbook，而 recall 被裁定永不返回经验）。三处都是静态常量，断一处，
 *  模型的认知面就退回「只有技能」。 */
describe('pick_skill 说明面提及经验', () => {
  it('工具 description 与 name/intent 参数说明提到经验', () => {
    const src = read('src/renderer/src/tools/built-in-tools.ts')
    expect(src).toContain('an installed skill or an experience learned from past conversations')
    expect(src).toContain('or the exact title (or an alias) of an experience')
  })
  it('Tool Protocols 手册：两种条目 + recall 不返回经验 + 信封前缀', () => {
    const src = read('src/renderer/src/tools/tool-instructions.ts')
    expect(src).toContain('## Selected Skill:')
    expect(src).toContain('## Experience:')
    // 源码里 recall 带模板字面量转义（\`recall\`），钉不带反引号的稳定子串
    expect(src).toContain('Experiences are NOT returned by')
    expect(src).toContain('the only way to pull one deliberately')
    expect(src).toContain('## 适用场景 / ## 步骤 / ## 注意事项')
  })
  it('Local Knowledge 节：playbook 指向 pick_skill，不再指向 recall', () => {
    const src = read('src/renderer/src/agent/system-prompt-builder.ts')
    expect(src).toContain('recall does NOT return experiences')
    expect(src).toContain('for a reusable playbook, pick_skill by intent')
    expect(src).not.toContain('past decisions, playbooks, related past work')
  })
})
