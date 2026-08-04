export interface KnowledgeFile {
  id: string
  filePath: string      // relative path within knowledge/raw/
  title: string
  sourceType: 'file' | 'url' | 'experience'
  sourceUrl: string | null
  sourcePath: string | null
  convId: string | null
  contentHash: string | null
  status: 'raw' | 'compiled'
  createdAt: string
  compiledAt: string | null
  wikiOutputs: string[] | null  // wiki file paths produced by compilation
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
  sourceType?: 'file' | 'url' | 'experience'
  search?: string
  sortBy?: 'createdAt' | 'title' | 'status'
  sortOrder?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface KnowledgeListResult {
  items: KnowledgeFile[]
  total: number
  page: number
  pageSize: number
}
