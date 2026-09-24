import type { ExperienceRecord, ExperienceDraft } from '../../../shared/types/experience-types'
import { SkillKeywordAgent } from '../agent/one-shot-agent'
import type { LlmAdapter } from '../llm/adapter'
import { getHost } from '../agent/host'

export interface ExperienceLlmConfig {
  adapter: LlmAdapter
  apiKey: string
  baseURL: string
  model: string
}

export class ExperienceManager {
  private cached: ExperienceRecord[] = []
  private cachedAt = 0
  private readonly CACHE_TTL_MS = 60_000
  private skillKeywordAgent = new SkillKeywordAgent()
  /** Feature master switch (设置 → 经验). Off = the agent neither sees the
   *  experience index nor trigger-matches; existing records stay browsable. */
  private enabled = true

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private async ensureCached(): Promise<ExperienceRecord[]> {
    if (Date.now() - this.cachedAt > this.CACHE_TTL_MS) {
      this.cached = await getHost().listExperiences()
      this.cachedAt = Date.now()
    }
    return this.cached
  }

  async list(): Promise<ExperienceRecord[]> {
    return this.ensureCached()
  }

  async refresh(): Promise<ExperienceRecord[]> {
    this.cached = await getHost().listExperiences()
    this.cachedAt = Date.now()
    return this.cached
  }

  async save(draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord; rejectedFiles?: string[] }> {
    const result = await getHost().saveExperienceRecord(draft)
    if (result.rejectedFiles?.length) {
      console.warn('[experience] save rejected script files:', result.rejectedFiles.join(', '))
    }
    // 淘汰可见（PLAN-experience-scripts 1.6）：无声淘汰丢掉的是已验证的
    // 自动化。Manager 在两 个进程都有实例，DOM 只在渲染端存在——用
    // CustomEvent 把事件递给面板（面板监听后弹 antd message）。
    if (result.evicted && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('pm-experience-evicted', { detail: { record: result.evicted } }))
      } catch { /* 结构化克隆失败的极端情形——淘汰本身已发生，不因通知失败回滚 */ }
    }
    this.cachedAt = 0
    return result
  }

  async delete(name: string): Promise<void> {
    await getHost().deleteExperienceRecord(name)
    this.cachedAt = 0
  }

  async read(name: string): Promise<string | null> {
    return getHost().readExperienceRecord(name)
  }

  /** Companion script content (panel's read-only view). */
  readFile(name: string, relPath: string): Promise<string | null> {
    return getHost().readExperienceFile(name, relPath)
  }

  async touch(name: string): Promise<void> {
    await getHost().touchExperienceRecord(name)
    this.cachedAt = 0
  }

  /**
   * Trigger-keyword matching (skill-style): return experiences whose triggers
   * match the latest user message. Zero cost when nothing matches.
   */
  async matchByTriggers(userText: string): Promise<ExperienceRecord[]> {
    if (!this.enabled) return []
    const records = await this.ensureCached()
    if (records.length === 0 || !userText) return []
    const lower = userText.toLowerCase()
    const matched: ExperienceRecord[] = []
    for (const rec of records) {
      if (!rec.triggers || rec.triggers.length === 0) continue
      if (rec.triggers.some((kw) => kw && lower.includes(kw.toLowerCase()))) matched.push(rec)
    }
    return matched
  }

  /**
   * Name-only index (progressive disclosure level 0, second channel): a
   * comma-separated list of experience names, ~100 tokens for 20 experiences.
   * Injected into the system prompt so the model knows the library exists and
   * can pick_skill an experience by name to read it in full.
   */
  async buildNameIndex(): Promise<string | null> {
    if (!this.enabled) return null
    const records = await this.ensureCached()
    if (records.length === 0) return null
    return `## Experience Index

Available past experiences (use pick_skill with name to read one in full):

${records.map((r) => r.name).join(', ')}`
  }

  /**
   * Extract trigger keywords for an experience (idempotent: skips when the
   * record already has triggers). Callers run this fire-and-forget after save.
   */
  async ensureTriggers(name: string, llm: ExperienceLlmConfig): Promise<void> {
    const rec = (await this.ensureCached()).find((r) => r.name === name)
    if (!rec || (rec.triggers && rec.triggers.length > 0)) return
    const raw = await this.read(name)
    if (!raw) return
    try {
      const keywords = await this.skillKeywordAgent.execute(
        { rawContent: raw },
        {
          llmConfig: { adapter: llm.adapter, apiKey: llm.apiKey, baseURL: llm.baseURL, model: llm.model },
          maxTokens: 500
        }
      )
      const trimmed = keywords
        .map((k) => k.trim())
        .filter((k) => k.length > 0 && k.length <= 40)
        .slice(0, 12)
      if (trimmed.length > 0) {
        const { content } = parseExperienceMd(raw, rec.title)
        await this.save({
          title: rec.title,
          description: rec.description,
          content: content || rec.description,
          category: rec.category,
          sourceConversationId: rec.sourceConversationId,
          triggers: trimmed
        })
        console.log(`[ExperienceManager] Extracted ${trimmed.length} trigger keyword(s) for "${name}"`)
      }
    } catch (e) {
      console.warn(`[ExperienceManager] Trigger extraction failed for "${name}":`, e)
    }
  }
}

function parseExperienceMd(raw: string, fallbackTitle: string): { title: string; content: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return { title: fallbackTitle, content: raw }
  const fm = m[1]
  const content = m[2].trim()
  const titleMatch = fm.match(/^title:\s*(.*)$/m)
  let title = titleMatch ? titleMatch[1].trim() : fallbackTitle
  title = title.replace(/^["']|["']$/g, '')
  return { title, content }
}
