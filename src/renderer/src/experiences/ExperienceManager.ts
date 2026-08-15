import type { ExperienceRecord, ExperienceDraft } from '../../../shared/types/experience-types'
import { MAX_EXPERIENCES } from '../../../shared/types/experience-types'
import type { KnowledgeManager } from '../knowledge/KnowledgeManager'

export class ExperienceManager {
  private cached: ExperienceRecord[] = []
  private cachedAt = 0
  private readonly CACHE_TTL_MS = 60_000

  private async ensureCached(): Promise<ExperienceRecord[]> {
    if (Date.now() - this.cachedAt > this.CACHE_TTL_MS) {
      this.cached = await window.electronAPI.listExperiences()
      this.cachedAt = Date.now()
    }
    return this.cached
  }

  async list(): Promise<ExperienceRecord[]> {
    return this.ensureCached()
  }

  async refresh(): Promise<ExperienceRecord[]> {
    this.cached = await window.electronAPI.listExperiences()
    this.cachedAt = Date.now()
    return this.cached
  }

  async save(draft: ExperienceDraft): Promise<{ record: ExperienceRecord; evicted?: ExperienceRecord }> {
    const result = await window.electronAPI.saveExperienceRecord(draft)
    this.cachedAt = 0
    return result
  }

  async delete(name: string): Promise<void> {
    await window.electronAPI.deleteExperienceRecord(name)
    this.cachedAt = 0
  }

  async read(name: string): Promise<string | null> {
    return window.electronAPI.readExperienceRecord(name)
  }

  async touch(name: string): Promise<void> {
    await window.electronAPI.touchExperienceRecord(name)
    this.cachedAt = 0
  }

  /**
   * Level-0 progressive disclosure index for the system prompt:
   * one line per experience (title + short description), never the full body.
   */
  async buildIndex(): Promise<string | null> {
    const records = await this.ensureCached()
    if (records.length === 0) return null
    const lines = records.map((r) => `- ${r.title}${r.description ? ` — ${r.description}` : ''}`)
    return [
      '## Experience Index',
      '',
      `You have ${records.length}/${MAX_EXPERIENCES} past workflow experiences (lessons learned, optimizations, user preferences discovered in past sessions).`,
      'Use the experience_read tool to read the full experience when relevant.',
      '',
      ...lines,
    ].join('\n')
  }

  /**
   * One-time migration: import the latest knowledge-base experiences
   * (source_type = 'experience') into the dedicated experience store.
   * Source files are kept untouched.
   */
  async migrateFromKnowledge(km: KnowledgeManager): Promise<{ migrated: number }> {
    const files = await km.listFiles()
    const experienceFiles = files
      .filter((f) => f.sourceType === 'experience')
      .slice(0, MAX_EXPERIENCES)
    let migrated = 0
    for (const file of experienceFiles) {
      try {
        const raw = await km.readRawContent(file.filePath)
        if (!raw) continue
        const { title, content } = parseExperienceMd(raw, file.title)
        if (!content || content.trim().length < 10) continue
        await this.save({
          title: title || file.title || 'Untitled experience',
          description: content.trim().slice(0, 120),
          content,
          category: 'general',
          sourceConversationId: file.convId ?? undefined,
        })
        migrated++
      } catch (e) {
        console.error('[ExperienceManager] migration failed for', file.title, e)
      }
    }
    if (migrated > 0) console.log(`[ExperienceManager] Migrated ${migrated} legacy experiences`)
    return { migrated }
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
