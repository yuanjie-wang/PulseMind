export interface KnowledgeFile {
  id: string
  filePath: string      // relative path within knowledge/bases/<baseId>/raw/
  title: string
  sourceType: 'file' | 'url' | 'experience' | 'favorite'
  sourceUrl: string | null
  sourcePath: string | null
  convId: string | null
  contentHash: string | null
  status: 'raw' | 'compiled'
  createdAt: string
  compiledAt: string | null
  wikiOutputs: string[] | null  // wiki file paths produced by compilation
  /** Owning knowledge base. 'default' = the implicit default base. */
  baseId: string
}

/** The always-present base every file falls back to. Cannot be deleted. */
export const DEFAULT_BASE_ID = 'default'

/** A user-named knowledge base with physical file isolation. */
export interface KnowledgeBase {
  id: string
  name: string
  colorHue: number | null
  createdAt: string
  /** File count in this base (the list endpoint joins it in). */
  fileCount?: number
}

export interface KnowledgeStats {
  total: number
  raw: number
  compiled: number
  wikiFileCount: number
}

export interface KnowledgeImportResult {
  success: boolean
  duplicate?: boolean
  file?: KnowledgeFile
  error?: string
}

export interface KnowledgeListOptions {
  status?: 'raw' | 'compiled'
  sourceType?: 'file' | 'url' | 'experience' | 'favorite'
  search?: string
  sortBy?: 'createdAt' | 'title' | 'status'
  sortOrder?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  /** Scope to one knowledge base. `undefined` = no filter (all bases);
   *  a string = that base. */
  baseId?: string
}

export interface KnowledgeListResult {
  items: KnowledgeFile[]
  total: number
  page: number
  pageSize: number
}
