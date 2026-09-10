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

  async save(draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord }> {
    const result = await getHost().saveExperienceRecord(draft)
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

  async touch(name: string): Promise<void> {
    await getHost().touchExperienceRecord(name)
    this.cachedAt = 0
  }

  /**
   * Trigger-keyword matching (skill-style): return experiences whose triggers
   * match the latest user message. Zero cost when nothing matches.
   */
  async matchByTriggers(userText: string): Promise<ExperienceRecord[]> {
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
