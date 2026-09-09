export interface ExperienceRecord {
  id: string
  name: string
  title: string
  description: string
  category: string
  sourceConversationId?: string
  createdAt: string
  lastUsedAt?: string | null
  useCount: number
  /** Trigger keywords matched against the latest user message to surface this experience. */
  triggers?: string[]
}

export interface ExperienceDraft {
  title: string
  description: string
  content: string
  category: string
  sourceConversationId?: string
  triggers?: string[]
}

export const MAX_EXPERIENCES = 20

export const EXPERIENCE_CATEGORIES = ['code', 'architecture', 'user_pref', 'decision', 'general'] as const
