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

function rowToProfile(row: any): SubAgentProfile {
  return {
    id: row.id,
    name: row.name,
    basePrompt: row.base_prompt,
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

export class SubAgentStore {
  getAll(): SubAgentProfile[] {
    const rows = getDb().prepare('SELECT * FROM subagent_profiles ORDER BY is_built_in DESC, id ASC').all() as any[]
    if (rows.length === 0) {
      this.save(DEFAULT_PROFILES)
      return DEFAULT_PROFILES
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
        if (!existing.basePrompt || (existing as any).description) {
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
        const oldDesc = (existing as any).description
        if (!existing.basePrompt && oldDesc) {
          (existing as any).basePrompt = oldDesc
          changed = true
        }
        merged.push(existing)
      }
    }

    for (const p of parsed) {
      if (!merged.find((m) => m.id === p.id)) {
        const oldDesc = (p as any).description
        if (!p.basePrompt && oldDesc) {
          (p as any).basePrompt = oldDesc
          changed = true
        }
        merged.push(p)
      }
    }

    if (changed) {
      this.save(merged)
    }
    return merged
  }

  save(profiles: SubAgentProfile[]): void {
    const db = getDb()
    db.transaction(() => {
      db.prepare('DELETE FROM subagent_profiles').run()
      const insert = db.prepare(`INSERT INTO subagent_profiles
        (id, name, base_prompt, allowed_tools, allowed_mcp_servers, allowed_skills, profile_id, max_tokens, max_loop_iterations, is_built_in, enabled)
        VALUES (@id, @name, @base_prompt, @allowed_tools, @allowed_mcp_servers, @allowed_skills, @profile_id, @max_tokens, @max_loop_iterations, @is_built_in, @enabled)`)
      for (const p of profiles) {
        insert.run(profileToRow(p))
      }
    })()
  }

  reset(): SubAgentProfile[] {
    this.save(DEFAULT_PROFILES)
    return DEFAULT_PROFILES
  }
}

export const subAgentStore = new SubAgentStore()
