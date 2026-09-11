// ── Tool store (PLAN-0.4.0 M5.1) ──
// One directory per tool under ~/.pulsemind/tools/<id>/:
//   tool.json    — manifest
//   app.html     — the generated app (single file)
//   storage.json — bridge KV persistence (M6.6)
// Templates live in ~/.pulsemind/tools/templates/ (copied from the app bundle
// on first run) and are surfaced read-only.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './index'
import type { ToolCreateInput, ToolUpdateInput, UserTool } from '../../shared/types/user-tool'

export const TOOLS_DIR = join(DATA_DIR, 'tools')
export const TOOL_TEMPLATES_DIR = join(TOOLS_DIR, 'templates')

function toolDir(id: string): string {
  return join(TOOLS_DIR, id)
}

function manifestPath(id: string): string {
  return join(toolDir(id), 'tool.json')
}

function readManifest(id: string): UserTool | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(id), 'utf-8')) as UserTool
    if (!parsed || parsed.id !== id) return null
    return parsed
  } catch {
    return null
  }
}

function readTemplateManifest(templateId: string): UserTool | null {
  try {
    const parsed = JSON.parse(readFileSync(join(TOOL_TEMPLATES_DIR, templateId, 'tool.json'), 'utf-8')) as UserTool
    return parsed
  } catch {
    return null
  }
}

function listTemplateIds(): string[] {
  if (!existsSync(TOOL_TEMPLATES_DIR)) return []
  return readdirSync(TOOL_TEMPLATES_DIR).filter((name) => {
    return existsSync(join(TOOL_TEMPLATES_DIR, name, 'tool.json'))
  })
}

export const toolStore = {
  /** Ensure the directories exist. */
  init(): void {
    mkdirSync(TOOLS_DIR, { recursive: true })
  },

  list(): UserTool[] {
    if (!existsSync(TOOLS_DIR)) return []
    return readdirSync(TOOLS_DIR)
      .filter((name) => !name.startsWith('.') && existsSync(manifestPath(name)))
      .map((name) => readManifest(name))
      .filter((t): t is UserTool => t != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  get(id: string): UserTool | null {
    return readManifest(id)
  },

  /** A read-only template surfaced as a pseudo-tool. */
  getTemplate(templateId: string): (UserTool & { isTemplate: true }) | null {
    const manifest = readTemplateManifest(templateId)
    return manifest ? { ...manifest, isTemplate: true } : null
  },

  listTemplates(): Array<UserTool & { isTemplate: true }> {
    return listTemplateIds()
      .map((id) => this.getTemplate(id))
      .filter((t): t is UserTool & { isTemplate: true } => t != null)
  },

  readHtml(id: string): string | null {
    const manifest = readManifest(id)
    if (!manifest) return null
    try {
      return readFileSync(join(toolDir(id), manifest.htmlPath || 'app.html'), 'utf-8')
    } catch {
      return null
    }
  },

  readTemplateHtml(templateId: string): string | null {
    const manifest = readTemplateManifest(templateId)
    if (!manifest) return null
    try {
      return readFileSync(join(TOOL_TEMPLATES_DIR, templateId, manifest.htmlPath || 'app.html'), 'utf-8')
    } catch {
      return null
    }
  },

  /** Create a tool (optionally cloning a template's HTML). */
  create(input: ToolCreateInput): UserTool {
    const now = new Date().toISOString()
    const id = `tool_${randomUUID().slice(0, 8)}`
    const tool: UserTool = {
      id,
      name: input.name.trim() || '未命名工具',
      description: input.description ?? '',
      category: input.category,
      htmlPath: 'app.html',
      capabilities: input.capabilities ?? [],
      sourceTemplateId: input.sourceTemplateId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }
    mkdirSync(toolDir(id), { recursive: true })
    if (input.sourceTemplateId) {
      const html = this.readTemplateHtml(input.sourceTemplateId)
      if (html) writeFileSync(join(toolDir(id), 'app.html'), html, 'utf-8')
      const template = readTemplateManifest(input.sourceTemplateId)
      if (template) {
        tool.capabilities = [...template.capabilities]
        tool.category = template.category
        if (!tool.description) tool.description = template.description
      }
    }
    writeFileSync(manifestPath(id), JSON.stringify(tool, null, 2), 'utf-8')
    return tool
  },

  update(id: string, patch: ToolUpdateInput): UserTool | null {
    const existing = readManifest(id)
    if (!existing) return null
    const next: UserTool = {
      ...existing,
      ...patch,
      id,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(manifestPath(id), JSON.stringify(next, null, 2), 'utf-8')
    return next
  },

  /** Persist generated HTML (called by the studio after generation). */
  writeHtml(id: string, html: string): void {
    const manifest = readManifest(id)
    if (!manifest) throw new Error(`tool not found: ${id}`)
    mkdirSync(toolDir(id), { recursive: true })
    writeFileSync(join(toolDir(id), manifest.htmlPath || 'app.html'), html, 'utf-8')
  },

  remove(id: string): void {
    rmSync(toolDir(id), { recursive: true, force: true })
  },
}
