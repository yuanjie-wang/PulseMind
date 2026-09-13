import type { SubAgentProfile } from '../../shared/types/subagent'
import { getDb } from './database'

const BUILTIN_LOCKED_TOOLS = [
  'memory_search', 'memory_save', 'conversation_search',
  'knowledge_search', 'knowledge_read',
]

const BASE_TOOLS = ['read', 'write', 'edit', 'list_dir', 'search', 'find', 'exec', 'pick_skill']

const CANVAS_PROMPT = `You are a frontend page generator. Generate HTML content with inline CSS and JavaScript.

Write the output to index.html.

IMPORTANT — Output format:
- Generate only the **inner content** that fills the container. Do NOT include <!DOCTYPE html>, <html>, <head>, or <body> tags — those are provided by the container.
- Include your own <style> and <script> tags inside the content as needed
- Use modern CSS (flexbox, grid, custom properties)
- **Every element in the body must have a unique id attribute** — no element without an id
- **Fill the entire container completely** — the root element must use width:100%;height:100%;margin:0;padding:0 so no gaps remain. All child elements should also span the full available width unless intentionally inset.
- **Responsive layout is required** — use CSS flexbox or grid for fluid layouts that adapt to any container size. Use relative units (%, vh, vw, fr, em/rem). Avoid fixed pixel dimensions for container-level sizing. Add @media (prefers-color-scheme: dark) support for color scheme adaptation.
- **No scrollbars on the container** — content should flex to fit so the container itself has no overflow scrolling. Internal scrollable areas within the design are acceptable for things like lists or chat panes.
- Use CSS transitions/animations sparingly for polish
- Do NOT use external CDN links
- All icons should be done with inline SVGs or Unicode characters — no external icon libraries are available.
- Do NOT open or preview the page in the system browser — the result is rendered automatically inside the application.

The working directory contains an index.html file with the current state. **Always start each task by reading this file** to understand what already exists, then plan your approach before making any changes.

When modifying, replace the entire content of index.html with your complete generated HTML output — do not make partial edits. Do NOT create any additional files.

When the user provides annotations, they describe specific areas of the rendered page that need changes. Pay close attention to the annotation positions and text.

Workflow:
1. Use the **read** tool to examine the current content of index.html
2. Use the **write** tool to output your complete HTML (replaces the file entirely)
3. Iterate as many times as needed using read, write, edit, search, find, and exec tools
4. For complex pages, build incrementally: generate a basic structure first, then refine
5. When you are done, output the final HTML in a code block (no need to call finish — the result is captured automatically)`

const GENERAL_PROMPT = `You are a sub-agent executing a delegated task.

Guidelines:
- Focus exclusively on the task above. Ignore anything not relevant to it.
- You CANNOT install skills or modify tool preferences.
- When you complete the task, provide a concise summary of your findings.
- Do NOT ask the user for input — work autonomously.`

/** 基础设施内置项：spawn/canvas 运行所需的子代理人设，不进入 @ 召唤列表。 */
const DEFAULT_PROFILES: SubAgentProfile[] = [
  {
    id: 'subagent-general',
    name: '通用子代理',
    basePrompt: GENERAL_PROMPT,
    allowedTools: [...BASE_TOOLS, ...BUILTIN_LOCKED_TOOLS],
    allowedMcpServers: [],
    allowedSkills: [],
    maxLoopIterations: 20,
    isBuiltIn: true,
  },
  {
    id: 'subagent-canvas',
    name: '画布子代理',
    basePrompt: CANVAS_PROMPT,
    allowedTools: [...BASE_TOOLS, ...BUILTIN_LOCKED_TOOLS],
    allowedMcpServers: [],
    allowedSkills: [],
    maxLoopIterations: 20,
    isBuiltIn: true,
  },
]

/** 示例专家（预置）：展示「人设 + 方法论 + 输出规范 + 边界约束」结构化配置包。
 *  可编辑、可删除；「重置默认」时恢复。空数组 = 不限制（沿用工具绑定语义）。 */
const PRESET_EXPERTS: SubAgentProfile[] = [
  {
    id: 'expert-writing',
    name: '写作专家',
    icon: '✍️',
    description: '深度文章与商业文案写作顾问，从审题到成稿全流程陪跑',
    basePrompt: '资深中文写作顾问，10 年以上内容行业经验，擅长深度文章、公众号长文与商业文案。文风克制精准，重视逻辑与节奏，反对空话套话。',
    methodology: '五步工作法：\n1. 审题——明确读者、目标与核心观点；\n2. 搭结构——先给大纲（开头钩子 / 论点分层 / 结尾收束），与用户确认后再动笔；\n3. 初稿——一次成稿，不求完美；\n4. 打磨——逐段检查逻辑链、删冗余、调节奏；\n5. 标题——提供 3 个备选标题并说明理由。',
    outputSpec: '默认输出 Markdown；长文先大纲后成稿；修改意见用「问题 → 示例 → 建议」三段式；每个建议都给出理由，而非只给结论。',
    constraints: '不编造数据、案例与引用；用户素材不足时先提问再动笔；不改动用户已明确认可的段落，除非指出事实或逻辑错误。',
    allowedTools: [],
    allowedMcpServers: [],
    allowedSkills: [],
    enabled: true,
  },
  {
    id: 'expert-code-review',
    name: '代码审查专家',
    icon: '🔍',
    description: '严格但务实的代码审查专家，按严重度分级输出可执行建议',
    basePrompt: '资深代码审查工程师，精通 TypeScript / Python / Go，长期负责大型项目的 Code Review。审查风格严格但务实：先看正确性再看风格，永远给出可执行的修改建议而非空洞批评。',
    methodology: '审查顺序：\n1. 正确性——边界条件、错误处理、并发安全；\n2. 安全——注入、越权、敏感信息泄露；\n3. 可维护性——命名、重复、耦合；\n4. 性能——只在有明显问题时提出。\n先用 read/search/git 工具阅读上下文，不凭代码片段下结论。',
    outputSpec: '按严重度分级输出：🔴 必须修复（正确性 / 安全）、🟡 建议修复（可维护性）、🟢 可选优化。每个问题包含：位置（文件:行为）、问题说明、修改建议（必要时给 diff 片段）。结尾给一句总体评价。',
    constraints: '只审查，不擅自大改；对拿不准的上下文先用工具确认；不评论与代码无关的内容；涉及安全问题时明确标注风险等级。',
    allowedTools: ['read', 'search', 'find', 'list_dir', 'exec', 'git_status', 'git_diff', 'git_log'],
    allowedMcpServers: [],
    allowedSkills: [],
    enabled: true,
  },
  {
    id: 'expert-translation',
    name: '翻译专家',
    icon: '🌐',
    description: '中英互译专家，信达雅优先，术语全文一致',
    basePrompt: '资深中英双语译者，10 年以上本地化与文学翻译经验。信达雅为纲：先忠实原意，再通顺流畅，最后兼顾文采。熟悉技术文档、商业合同与文学文本的不同语域。',
    methodology: '流程：\n1. 判断文本类型与目标读者，确定语域；\n2. 术语表先行——识别关键术语并保持全文一致；\n3. 意译为主，避免逐词硬译；\n4. 交付后附「翻译要点」说明取舍（如有）。',
    outputSpec: '译文以引用块给出；专有名词首次出现附原文括注；用户未指明目标语言时，中文文本译英、英文文本译中；长文分段对照（原文 / 译文）。',
    constraints: '不增删原文实质信息；含糊或歧义处不擅自取舍，列出多种译法并说明差异；金额、日期、单位等关键数字翻译后自校一遍。',
    allowedTools: [],
    allowedMcpServers: [],
    allowedSkills: [],
    enabled: true,
  },
]

function rowToProfile(row: any): SubAgentProfile {
  return {
    id: row.id,
    name: row.name,
    basePrompt: row.base_prompt,
    description: row.description || undefined,
    icon: row.icon || undefined,
    methodology: row.methodology || undefined,
    outputSpec: row.output_spec || undefined,
    constraints: row.constraints || undefined,
    knowledgeFileIds: JSON.parse(row.knowledge_file_ids || '[]'),
    allowedTools: JSON.parse(row.allowed_tools || '[]'),
    allowedMcpServers: JSON.parse(row.allowed_mcp_servers || '[]'),
    allowedSkills: JSON.parse(row.allowed_skills || '[]'),
    profileId: row.profile_id || undefined,
    maxTokens: row.max_tokens ?? undefined,
    maxLoopIterations: row.max_loop_iterations ?? undefined,
    isBuiltIn: row.is_built_in === 1,
    enabled: row.enabled === 1,
  }
}

function profileToRow(p: SubAgentProfile): Record<string, any> {
  return {
    id: p.id,
    name: p.name,
    base_prompt: p.basePrompt || '',
    description: p.description || '',
    icon: p.icon || null,
    methodology: p.methodology || '',
    output_spec: p.outputSpec || '',
    constraints: p.constraints || '',
    knowledge_file_ids: JSON.stringify(p.knowledgeFileIds || []),
    allowed_tools: JSON.stringify(p.allowedTools || []),
    allowed_mcp_servers: JSON.stringify(p.allowedMcpServers || []),
    allowed_skills: JSON.stringify(p.allowedSkills || []),
    profile_id: p.profileId || null,
    max_tokens: p.maxTokens ?? null,
    max_loop_iterations: p.maxLoopIterations ?? null,
    is_built_in: p.isBuiltIn ? 1 : 0,
    enabled: p.enabled !== false ? 1 : 0,
  }
}

const INSERT_SQL = `INSERT INTO subagent_profiles
  (id, name, base_prompt, description, icon, methodology, output_spec, constraints, knowledge_file_ids,
   allowed_tools, allowed_mcp_servers, allowed_skills, profile_id, max_tokens, max_loop_iterations, is_built_in, enabled)
  VALUES (@id, @name, @base_prompt, @description, @icon, @methodology, @output_spec, @constraints, @knowledge_file_ids,
   @allowed_tools, @allowed_mcp_servers, @allowed_skills, @profile_id, @max_tokens, @max_loop_iterations, @is_built_in, @enabled)`

export class SubAgentStore {
  getAll(): SubAgentProfile[] {
    const rows = getDb().prepare('SELECT * FROM subagent_profiles ORDER BY is_built_in DESC, id ASC').all() as any[]
    if (rows.length === 0) {
      const seeded = [...DEFAULT_PROFILES, ...PRESET_EXPERTS]
      this.save(seeded)
      return seeded
    }

    const parsed = rows.map(rowToProfile)
    const merged: SubAgentProfile[] = []
    let changed = false

    for (const def of DEFAULT_PROFILES) {
      const existing = parsed.find((p) => p.id === def.id)
      if (!existing) {
        merged.push({ ...def })
        changed = true
      } else if (existing.isBuiltIn) {
        // 内置项：缺提示词时回填，锁定工具强制合并。
        if (!existing.basePrompt) {
          existing.basePrompt = def.basePrompt
          changed = true
        }
        const allTools = [...existing.allowedTools]
        for (const t of BUILTIN_LOCKED_TOOLS) {
          if (!allTools.includes(t)) { allTools.push(t); changed = true }
        }
        for (const t of BASE_TOOLS) {
          if (!allTools.includes(t)) { allTools.push(t); changed = true }
        }
        if (existing.id === 'subagent-canvas' && !allTools.includes('pick_skill')) {
          allTools.push('pick_skill'); changed = true
        }
        merged.push({ ...existing, allowedTools: allTools })
      } else {
        merged.push(existing)
      }
    }

    for (const p of parsed) {
      if (!merged.find((m) => m.id === p.id)) {
        merged.push(p)
      }
    }

    if (changed) {
      this.save(merged)
    }
    return merged
  }

  getById(id: string): SubAgentProfile | null {
    const row = getDb().prepare('SELECT * FROM subagent_profiles WHERE id = ?').get(id) as any
    return row ? rowToProfile(row) : null
  }

  save(profiles: SubAgentProfile[]): void {
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM subagent_profiles').run()
      const insert = db.prepare(INSERT_SQL)
      for (const p of profiles) {
        insert.run(profileToRow(p))
      }
    })()
  }

  /** 恢复默认：内置基础设施与示例专家按 id 覆盖回默认值，用户自定义保留。
   *  （旧实现会 DELETE 全表，与 UI「自定义配置将被保留」的承诺不符。） */
  reset(): SubAgentProfile[] {
    const db = getDb()
    db.transaction(() => {
      const upsert = db.prepare(INSERT_SQL)
      for (const p of [...DEFAULT_PROFILES, ...PRESET_EXPERTS]) {
        upsert.run(profileToRow(p))
      }
    })()
    return this.getAll()
  }
}

export const subAgentStore = new SubAgentStore()
