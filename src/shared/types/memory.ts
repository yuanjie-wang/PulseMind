// --- Memory Entry Types ---

const MEMORY_TYPES = ['auto', 'manual', 'decision', 'fact', 'preference', 'experience'] as const
const MEMORY_CATEGORIES = ['code', 'architecture', 'user_pref', 'decision', 'general', 'experience'] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export interface MemoryEntry {
  id: string
  content: string
  type: MemoryType
  category: MemoryCategory
  source: string | null
  createdAt: string
  updatedAt: string
}

export interface MemoryCreateInput {
  content: string
  type?: MemoryType
  category?: MemoryCategory
  source?: string | null
}

export interface MemoryUpdateInput {
  content?: string
  type?: MemoryType
  category?: MemoryCategory
}

export interface MemorySearchResult {
  memories: MemoryEntry[]
  /** Matching snippet from FTS5, null if no FTS match */
  snippet: string | null
}

export interface MemorySearchInput {
  query: string
  category?: MemoryEntry['category']
  limit?: number
}

export interface MemoryMdContent {
  /** Full content of MEMORY.md */
  content: string
}

/** Settings for memory system behavior */
export interface MemoryPreferences {
  autoCaptureEnabled: boolean
  autoInjectEnabled: boolean
}

export const DEFAULT_MEMORY_PREFERENCES: MemoryPreferences = {
  autoCaptureEnabled: true,
  autoInjectEnabled: true
}

/** A conversation entry used for building memory context (Part C). */
export interface ConversationMemory {
  id: string
  title: string
  summary: string | null
  updatedAt: string
}
