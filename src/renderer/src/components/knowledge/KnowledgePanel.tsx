import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Typography, Space, Input, Modal, Tooltip, App, Table } from 'antd'
import {
  LinkOutlined,
  DeleteOutlined,
  FileTextOutlined,
  GlobalOutlined,
  BulbOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  SearchOutlined,
  FileSearchOutlined,
  LoadingOutlined
} from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import { useTranslation } from '../../i18n/useTranslation'
import type { KnowledgeFile, KnowledgeImportResult } from '../../../../shared/types/knowledge'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'

// ── Module-level dual queue engine ──
//
// Import and compile run on independent queues (not serialized). Module-level
// state survives mount/unmount so running async loops can continue and notify
// the remounted component via registered callbacks.

// ── Import queue (supports both file paths and URLs) ──
type ImportItem = { type: 'file'; path: string } | { type: 'url'; url: string }
const _pendingImportItems: ImportItem[] = []
let _importRunning = false
let _importCurrent = 0
let _importTotal = 0

// ── Compile queue ──
const _pendingCompileIds: string[] = []
let _compileRunning = false
let _compilingFileId: string | null = null
let _startupCompileEnqueued = false

// Enqueue un-compiled raw files for compilation on startup.
// Does NOT process them — the KnowledgePanel mount effect starts the compile
// queue when it detects _pendingCompileIds has items (see mount effect below).
export async function enqueueStartupCompile(): Promise<void> {
  if (_startupCompileEnqueued) return
  _startupCompileEnqueued = true
  try {
    const rawFiles = await window.electronAPI.knowledgeListFiles('raw') as Array<{ id: string }>
    if (rawFiles.length === 0) return
    for (const f of rawFiles) _pendingCompileIds.push(f.id)
    // Notify via callbacks if component is mounted
    if (_onMarkQueued) for (const f of rawFiles) _onMarkQueued(f.id)
  } catch { /* ignore */ }
}

// Callbacks — registered by the component on mount, cleared on unmount.
let _onProgress: ((current: number, total: number) => void) | null = null
let _onFileStatusChange: ((fileId: string, status: 'compiling' | 'compiled') => void) | null = null
let _onRefresh: (() => void) | null = null
let _onResetProgress: (() => void) | null = null
let _onMarkQueued: ((fileId: string) => void) | null = null
let _onStateChange: ((state: KnowledgePanelState) => void) | null = null

const { Text } = Typography

export interface KnowledgePanelHandle {
  handleAddFile: () => Promise<void>
  handleAddFolder: () => Promise<void>
  setShowUrlInput: (v: boolean) => void
  enqueueImport: (filePaths: string[]) => Promise<void>
  enqueueUrlImport: (url: string) => void
  enqueueCompileAll: () => Promise<void>
  handleReset: () => Promise<void>
}

export interface KnowledgePanelState {
  importProgress: { current: number; total: number } | null
  stats: { total: number; raw: number; compiled: number; wikiFileCount: number } | null
  isImporting: boolean
  canCompile: boolean
}

interface KnowledgePanelProps {
  knowledgeManager: KnowledgeManager
  onStateChange?: (state: KnowledgePanelState) => void
}

const SOURCE_TAGS: Record<string, { color: string; icon: React.ReactNode }> = {
  file: { color: '#858585', icon: <FileTextOutlined /> },
  url: { color: '#84b9ea', icon: <GlobalOutlined /> },
  experience: { color: 'orange', icon: <BulbOutlined /> }
}

/** Parse YAML frontmatter from markdown content. Returns [frontmatter, body]. */
function splitFrontmatter(content: string): [Record<string, string>, string] {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) return [{}, content]
  const end = trimmed.indexOf('---', 3)
  if (end === -1) return [{}, content]
  const raw = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 3).trimStart()
  const fields: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key && val) fields[key] = val
  }
  return [fields, body]
}

const FRONTMATTER_LABELS: Record<string, string> = {
  title: '标题',
  type: '类型',
  source_type: '来源类型',
  source_url: '来源 URL',
  source_path: '来源路径',
  source_conv_id: '对话 ID',
  extracted: '提取时间',
}

const FRONTMATTER_COLORS: Record<string, string> = {
  source: '#1677ff',
  entity: '#52c41a',
  concept: '#faad14',
  synthesis: '#eb2f96',
  file: '#1677ff',
  url: '#52c41a',
  experience: '#faad14',
}

function CompiledPreview({ content }: { content: string }): React.ReactElement {
  const [meta, body] = splitFrontmatter(content)

  return (
    <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
      {Object.keys(meta).length > 0 && (
        <div style={{ marginBottom: 16, padding: '12px 16px', background: '#f9f9f9', borderRadius: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(meta).map(([key, val]) => (
              <span key={key}>
                <span style={{ color: '#999', marginRight: 4, whiteSpace: 'nowrap' }}>{FRONTMATTER_LABELS[key] || key}:</span>
                {key === 'type' || key === 'source_type' ? (
                  <span style={{
                    display: 'inline-block',
                    padding: '0 6px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 500,
                    color: '#fff',
                    background: FRONTMATTER_COLORS[val] || '#666',
                    whiteSpace: 'nowrap',
                  }}>{val}</span>
                ) : key === 'source_url' || key === 'source_path' ? (
                  <code style={{ fontSize: 12, wordBreak: 'break-all', whiteSpace: 'normal' }}>{val}</code>
                ) : (
                  <span style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{val}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {body && <XMarkdown>{body}</XMarkdown>}
    </div>
  )
}

const KnowledgePanel = React.forwardRef<KnowledgePanelHandle, KnowledgePanelProps>(function KnowledgePanel({ knowledgeManager, onStateChange }, ref): React.ReactElement {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [loading, setLoading] = useState(false)
  const [compilingFileIds, setCompilingFileIds] = useState<Set<string>>(new Set())
  const [queuedFileIds, setQueuedFileIds] = useState<Set<string>>(new Set())
  const [urlInput, setUrlInput] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)
  const importCancelledRef = useRef(false)
  const [stats, setStats] = useState<{ total: number; raw: number; compiled: number; wikiFileCount: number } | null>(null)
  const [compiledPreview, setCompiledPreview] = useState<{ visible: boolean; content: string; title: string }>({ visible: false, content: '', title: '' })

  // ── Filter, sort, search, pagination, selection ──
  const [searchQuery, setSearchQuery] = useState('')
  const [filterSourceType, setFilterSourceType] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [sortState, setSortState] = useState<{ key: string; order: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(1)
  const pageSize = 50
  const [totalItems, setTotalItems] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // ── Progress ──
  const [, setImportProgress] = useState<{ current: number; total: number } | null>(null)

  const loadFiles = useCallback(async () => {
    try {
      const [result, currentStats] = await Promise.all([
        knowledgeManager.listFilesAdvanced({
          ...(searchQuery && { search: searchQuery }),
          ...(filterSourceType !== 'all' && { sourceType: filterSourceType as 'file' | 'url' | 'experience' }),
          ...(filterStatus !== 'all' && { status: filterStatus as 'raw' | 'compiled' }),
          ...(sortState && { sortBy: sortState.key as 'createdAt' | 'title' | 'status' }),
          ...(sortState && { sortOrder: sortState.order }),
          page,
          pageSize
        }),
        knowledgeManager.getStats()
      ])
      setFiles(result.items)
      setTotalItems(result.total)
      setStats(currentStats)
    } catch (err) {
      console.error('[KnowledgePanel] Failed to load files:', err)
    }
  }, [knowledgeManager, searchQuery, filterSourceType, filterStatus, sortState, page, pageSize])

  const loadFilesRef = useRef(loadFiles)
  loadFilesRef.current = loadFiles

  useEffect(() => {
    setLoading(true)
    loadFilesRef.current().finally(() => setLoading(false))
  }, [loadFiles])

  // ── On mount: register callbacks so the running loop (from previous mount)
  //     can update this component. On unmount: clear callbacks.
  //     mount — the old loops are still running.
  useEffect(() => {
    _onStateChange = onStateChange ?? null

    // _onProgress both updates React state (for the file list UI) and directly
    // notifies the parent (for the progress bar), bypassing the reportState
    // effect which would read stale React state on mount.
    _onProgress = (current, total) => {
      const p = { current, total }
      setImportProgress(p)
      _onStateChange?.({
        importProgress: p,
        stats,
        isImporting: true,
        canCompile: knowledgeManager.canCompile,
      })
    }
    _onRefresh = async () => {
      await loadFilesRef.current()
      // Push latest stats to parent so header stats stay in sync
      try {
        const currentStats = await knowledgeManager.getStats()
        setStats(currentStats)
        _onStateChange?.({
          importProgress: _importRunning ? { current: _importCurrent, total: _importTotal } : null,
          stats: currentStats,
          isImporting: _importRunning,
          canCompile: knowledgeManager.canCompile,
        })
      } catch { /* ignore */ }
    }
    _onFileStatusChange = (fileId, status) => {
      if (status === 'compiling') {
        setCompilingFileIds(prev => new Set(prev).add(fileId))
      } else {
        setCompilingFileIds(prev => { const next = new Set(prev); next.delete(fileId); return next })
        setQueuedFileIds(prev => { const next = new Set(prev); next.delete(fileId); return next })
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'compiled' } : f))
      }
    }
    _onResetProgress = () => {
      setImportProgress(null)
    }
    _onMarkQueued = (fileId) => {
      setQueuedFileIds(prev => new Set(prev).add(fileId))
    }

    // Sync progress via _onProgress so parent gets correct values immediately
    if (_importRunning) {
      _onProgress(_importCurrent, _importTotal)
    }

    // Restore the currently-compiling file's loading state
    if (_compileRunning && _compilingFileId) {
      setCompilingFileIds(new Set([_compilingFileId]))
    }

    // On remount, repopulate queuedFileIds from module-level queues and
    // start the compile queue if there are pending items (e.g. startup compile).
    if (_pendingCompileIds.length > 0) {
      setQueuedFileIds(new Set(_pendingCompileIds))
      if (!_compileRunning) {
        runCompileQueueRef.current()
      }
    }

    // Prime prevStateRef so subsequent reportState calls (for stats changes)
    // include the correct progress values from module-level state.
    prevStateRef.current = JSON.stringify({
      importProgress: _importRunning ? { current: _importCurrent, total: _importTotal } : null,
      stats,
      isImporting: _importRunning,
      canCompile: knowledgeManager.canCompile,
    })

    return () => {
      _onProgress = null
      _onFileStatusChange = null
      _onRefresh = null
      _onResetProgress = null
      _onMarkQueued = null
      _onStateChange = null
    }
  }, [])

  const handleAddFile = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Supported Documents',
        extensions: ['txt', 'md', 'html', 'pdf', 'docx', 'pptx', 'xlsx']
      }]
    })
    if (result.canceled || result.filePaths.length === 0) return
    enqueueImport(result.filePaths)
  }

  const handleAddFolder = async () => {
    const dialogResult = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory']
    })
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return

    const folderPath = dialogResult.filePaths[0]
    const { fileCount, filePaths } = await knowledgeManager.scanFolder(folderPath)

    if (fileCount === 0) {
      message.info('文件夹中没有可导入的文件')
      return
    }

    const { existing, new: newFiles } = await knowledgeManager.prepareImport(filePaths)

    Modal.confirm({
      title: '导入文件夹',
      content: `找到 ${filePaths.length} 个文件（${newFiles.length} 个新文件${existing.length > 0 ? `，${existing.length} 个已存在` : ''}），是否开始导入？`,
      okText: '开始导入',
      cancelText: t('common.cancel'),
      onOk: () => {
        if (newFiles.length > 0) enqueueImport(newFiles)
      }
    })
  }

  const handleAddUrl = async () => {
    const url = urlInput.trim()
    if (!url) return
    if (!/^https?:\/\/.+/.test(url)) {
      message.error('不支持的链接格式，仅支持 http/https 链接')
      return
    }

    // Pre-check duplicates before enqueuing
    const allFiles = await knowledgeManager.listFiles()
    const existing = allFiles.find(f => f.sourceType === 'url' && f.sourceUrl === url)
    if (existing) {
      Modal.confirm({
        title: '已导入过该链接',
        content: `"${url}" 已经导入过知识库，是否重新导入？`,
        okText: '重新导入',
        cancelText: '取消',
        onOk: async () => {
          try {
            await knowledgeManager.deleteFile(existing.id)
          } catch { /* ignore */ }
          setUrlInput('')
          setShowUrlInput(false)
          enqueueUrlImport(url)
        },
        onCancel: () => {
          setUrlInput('')
          setShowUrlInput(false)
        }
      })
      return
    }

    setUrlInput('')
    setShowUrlInput(false)
    enqueueUrlImport(url)
  }

  const handleDelete = (file: KnowledgeFile) => {
    Modal.confirm({
      title: t('knowledgePanel.confirmDelete'),
      content: file.title,
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        await knowledgeManager.deleteFile(file.id)
        loadFiles()
      }
    })
  }

  // ── Filter / Sort / Search / Selection handlers ──

  const handleSearch = (value: string) => {
    setSearchQuery(value)
    setPage(1)
    setSelectedIds(new Set())
  }

  const handlePageChange = (newPage: number) => {
    setPage(newPage)
    setSelectedIds(new Set())
  }

  const handleTableChange = useCallback((_pagination: any, filters: any, sorter: any) => {
    let changed = false

    const srcVal = filters.sourceType?.[0] || 'all'
    if (srcVal !== filterSourceType) {
      setFilterSourceType(srcVal)
      changed = true
    }

    const stVal = filters.status?.[0] || 'all'
    if (stVal !== filterStatus) {
      setFilterStatus(stVal)
      changed = true
    }

    const s = Array.isArray(sorter) ? sorter[0] : sorter
    if (s?.order && (s.columnKey || s.field)) {
      const key = (s.columnKey || s.field) as string
      if (key === 'title' || key === 'createdAt') {
        setSortState({ key, order: s.order === 'ascend' ? 'asc' : 'desc' })
        changed = true
      }
    } else if (sortState) {
      setSortState(null)
      changed = true
    }

    if (changed) {
      setPage(1)
      setSelectedIds(new Set())
    }
  }, [filterSourceType, filterStatus, sortState])

  const handleBatchCompile = () => {
    const rawSelected = files.filter(f => selectedIds.has(f.id) && f.status === 'raw')
    for (const f of rawSelected) {
      enqueueCompileOne(f.id)
    }
    setSelectedIds(new Set())
  }

  const handleBatchDelete = () => {
    Modal.confirm({
      title: '批量删除',
      content: `确定要删除选中的 ${selectedIds.size} 个文件吗？`,
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        for (const id of selectedIds) {
          await knowledgeManager.deleteFile(id)
        }
        setSelectedIds(new Set())
        loadFiles()
      }
    })
  }

  // ── Serial queue processor ──

  /** Enqueue import items and start processing. */
  const enqueueImport = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0) return
    const { existing, new: newFiles } = await knowledgeManager.prepareImport(filePaths)

    if (newFiles.length === 0) {
      if (existing.length > 0) message.info('所有文件均已导入')
      return
    }

    _pendingImportItems.push(...newFiles.map(p => ({ type: 'file' as const, path: p })))
    // Update progress immediately if queue is already running
    if (_importRunning) {
      _importTotal += newFiles.length
      _onProgress?.(_importCurrent, _importTotal)
    }
    runImportQueueRef.current()
  }, [knowledgeManager])

  /** Enqueue a URL for import. The URL is already validated and deduplicated by the caller. */
  const enqueueUrlImport = useCallback((url: string) => {
    _pendingImportItems.push({ type: 'url', url })
    // Update progress immediately if queue is already running
    if (_importRunning) {
      _importTotal += 1
      _onProgress?.(_importCurrent, _importTotal)
    }
    runImportQueueRef.current()
  }, [])

  /** Enqueue a single file for compilation. */
  const enqueueCompileOne = useCallback((fileId: string) => {
    _pendingCompileIds.push(fileId)
    setQueuedFileIds(prev => new Set(prev).add(fileId))
    runCompileQueueRef.current()
  }, [])

  /** Enqueue all raw files for compilation ("compile all" button). */
  const enqueueCompileAll = useCallback(async () => {
    const rawFiles = await knowledgeManager.listFiles('raw')
    if (rawFiles.length === 0) return
    for (const f of rawFiles) enqueueCompileOne(f.id)
  }, [knowledgeManager, enqueueCompileOne])

  // ── Independent queue processors ──
  //
  // Import and compile run independently (not serialized). Each is gated by its
  // own running flag. Module-level callbacks bridge back to React state.
  // Refs break the circular dependency between the two useCallback functions.

  const runImportQueueRef = useRef<() => Promise<void>>(async () => {})
  const runCompileQueueRef = useRef<() => Promise<void>>(async () => {})

  /** Process the import queue — supports both file paths and URLs. */
  const runImportQueue = useCallback(async () => {
    if (_importRunning) return
    if (_pendingImportItems.length === 0) return

    _importRunning = true
    _importCurrent = 0
    _importTotal = _pendingImportItems.length

    _onResetProgress?.()
    _onProgress?.(0, _importTotal)

    while (_pendingImportItems.length > 0) {
      const item = _pendingImportItems.shift()!
      try {
        let result: KnowledgeImportResult
        if (item.type === 'file') {
          const [r] = await knowledgeManager.importFiles([item.path])
          result = r
        } else {
          result = await knowledgeManager.importUrl(item.url)
        }
        if (result.success && result.file) {
          _pendingCompileIds.push(result.file.id)
          _onMarkQueued?.(result.file.id)
          // Trigger compile queue for this file
          runCompileQueueRef.current()
        }
      } catch {
        // Import failed — skip
      }
      _importCurrent++
      _importTotal = _importCurrent + _pendingImportItems.length  // Dynamic total handles mid-batch additions
      _onProgress?.(_importCurrent, _importTotal)
      _onRefresh?.()
    }

    // Import queue empty — keep progress bar at 100% for 1s, then fade
    await new Promise(r => setTimeout(r, 1000))
    setImportProgress(null)
    _onStateChange?.({
      importProgress: null,
      stats,
      isImporting: false,
      canCompile: knowledgeManager.canCompile,
    })

    _importRunning = false

    // If new imports were added during the 1s delay, pick them up
    if (_pendingImportItems.length > 0) {
      runImportQueueRef.current()
    }
  }, [knowledgeManager])

  /** Process the compile queue — independent of import state. */
  const runCompileQueue = useCallback(async () => {
    if (_compileRunning) return
    if (_pendingCompileIds.length === 0) return

    _compileRunning = true

    while (_pendingCompileIds.length > 0) {
      const fileId = _pendingCompileIds.shift()!
      _compilingFileId = fileId
      _onFileStatusChange?.(fileId, 'compiling')
      let lastError: unknown
      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 3000))
        try {
          const result = await knowledgeManager.compileFile(fileId)
          if (result.ok && result.written > 0) {
            _onFileStatusChange?.(fileId, 'compiled')
            lastError = undefined
            break
          }
          if (result.log === 'LLM not configured' || result.log === 'File not found or already compiled') {
            lastError = undefined
            break
          }
          lastError = result.log
        } catch (err) {
          lastError = err
        }
      }
      if (lastError) console.error('[KnowledgePanel] Compile failed:', fileId, lastError)
      _compilingFileId = null
      _onRefresh?.()
    }

    _compileRunning = false

    // If new items were added during processing, pick them up
    if (_pendingCompileIds.length > 0) {
      runCompileQueueRef.current()
    }
  }, [knowledgeManager])

  // Wire up refs to avoid circular dependency between the two callbacks
  runImportQueueRef.current = runImportQueue
  runCompileQueueRef.current = runCompileQueue

  /** Reset all knowledge: show confirmation, then clear everything */
  const handleReset = async (): Promise<void> => {
    Modal.confirm({
      title: '重置知识库',
      content: '确定要清空所有已导入的知识以及编译后的结果吗？此操作不可恢复。',
      okText: '确定重置',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const { deletedRaw, deletedWiki } = await knowledgeManager.clearAll()
          setFiles([])
          setStats(null)
          setTotalItems(0)
          setSelectedIds(new Set())
          setImportProgress(null)
          // Reset module-level state
          _pendingImportItems.length = 0
          _pendingCompileIds.length = 0
          _importRunning = false
          _importCurrent = 0
          _importTotal = 0
          _compileRunning = false
          _compilingFileId = null
          message.success(`已清空 ${deletedRaw} 个源文件、${deletedWiki} 个编译文件`)
        } catch (err) {
          console.error('[KnowledgePanel] Reset failed:', err)
          message.error('重置失败')
        }
      }
    })
  }

  // Expose handlers to parent (AppLayout for header buttons)
  React.useImperativeHandle(ref, () => ({
    handleAddFile,
    handleAddFolder,
    setShowUrlInput,
    enqueueImport,
    enqueueUrlImport,
    enqueueCompileAll,
    handleReset,
  }), [handleAddFile, handleAddFolder, enqueueImport, enqueueUrlImport, enqueueCompileAll, handleReset])

  // Report state changes to parent for header progress display.
  // Progress values are read from module-level state to avoid stale-closure
  // issues on mount (importProgress/compileProgress React state hasn't been
  // applied yet when this first runs). The _onProgress callback handles
  // real-time parent notification; reportState only covers other state like
  // stats changes.
  const prevStateRef = React.useRef<string>('')
  const reportState = useCallback(() => {
    if (!onStateChange) return
    const state: KnowledgePanelState = {
      importProgress: _importRunning ? { current: _importCurrent, total: _importTotal } : null,
      stats,
      isImporting: _importRunning,
      canCompile: knowledgeManager.canCompile,
    }
    const key = JSON.stringify(state)
    if (key !== prevStateRef.current) {
      prevStateRef.current = key
      onStateChange(state)
    }
  }, [stats, knowledgeManager.canCompile, onStateChange])

  React.useEffect(() => { reportState() }, [reportState])

  /** Open the raw file content in a preview modal. */
  const handleOpenRaw = async (file: KnowledgeFile) => {
    try {
      const content = await knowledgeManager.readRawContent(file.filePath)
      if (content) {
        setCompiledPreview({ visible: true, content, title: file.title })
      }
    } catch (err) {
      console.error('[KnowledgePanel] Failed to read raw content:', err)
    }
  }

  /** Open the original source file or URL. */
  const handleOpenSource = async (file: KnowledgeFile) => {
    if (file.sourceType === 'url' && file.sourceUrl) {
      try {
        await window.electronAPI.openExternal(file.sourceUrl)
      } catch (err) {
        console.error('[KnowledgePanel] Failed to open URL:', err)
      }
      return
    }
    if (!file.sourcePath) return
    try {
      await window.electronAPI.openFolder(file.sourcePath)
    } catch (err) {
      console.error('[KnowledgePanel] Failed to open source file:', err)
    }
  }

  // ── Tab: Raw Files ──
  const rawTab = (
    <div style={{ height: '100%' }}>
      {showUrlInput && (
        <Modal
          title={t('knowledgePanel.addUrl')}
          open={showUrlInput}
          onCancel={() => { importCancelledRef.current = true; window.electronAPI.knowledgeAbortImport(); setShowUrlInput(false); setUrlInput(''); setLoading(false) }}
          footer={null}
          width={420}
        >
          <Space.Compact style={{ display: 'flex', marginTop: 8 }}>
            <Input
              placeholder={t('knowledgePanel.addUrlPlaceholder')}
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onPressEnter={handleAddUrl}
              style={{ flex: 1 }}
            />
            <Button type="primary" onClick={handleAddUrl} loading={loading}>
              {t('knowledgePanel.addUrl')}
            </Button>
          </Space.Compact>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
            {t('knowledgePanel.addUrlHint')}
          </Typography.Text>
        </Modal>
      )}

      {/* ── Batch action bar ── */}
      {selectedIds.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 12px', background: '#fafafa', borderRadius: 4 }}>
          <Text style={{ fontSize: 12, color: '#666' }}>
            {t('knowledgePanel.selectedCount', { n: selectedIds.size })}
          </Text>
          <Button size="small" type="primary" ghost onClick={handleBatchCompile} disabled={!files.some(f => selectedIds.has(f.id) && f.status === 'raw')}>
            {t('knowledgePanel.batchCompile')}
          </Button>
          <Button size="small" danger onClick={handleBatchDelete}>
            {t('knowledgePanel.batchDelete')}
          </Button>
        </div>
      )}

      <Modal
        title={compiledPreview.title}
        open={compiledPreview.visible}
        onCancel={() => setCompiledPreview(prev => ({ ...prev, visible: false }))}
        footer={null}
        width="80%"
        style={{ top: 40 }}
      >
        <CompiledPreview content={compiledPreview.content} />
      </Modal>
      <style>{`
        .knowledge-table .ant-table-thead th { text-align: center !important; }
        .knowledge-table .ant-pagination .ant-pagination-item a { color: #000 !important; }
        .knowledge-table .ant-pagination .ant-pagination-item-active { border-color: #000 !important; }
        .knowledge-table .ant-pagination .ant-pagination-item-active a { color: #000 !important; font-weight: 700 !important; }
        .knowledge-table .ant-pagination .ant-pagination-prev button,
        .knowledge-table .ant-pagination .ant-pagination-next button { color: #000 !important; }
      `}</style>
      <Table
        className="knowledge-table"
        dataSource={files}
        rowKey="id"
        loading={loading}
        locale={{ emptyText: t('knowledgePanel.empty') }}
        rowSelection={{
          type: 'checkbox',
          selectedRowKeys: Array.from(selectedIds),
          onChange: (keys) => setSelectedIds(new Set(keys as string[])),
          preserveSelectedRowKeys: true,
        }}
        pagination={{
          current: page,
          total: totalItems,
          pageSize,
          onChange: handlePageChange,
          size: 'small',
          showSizeChanger: false,
        }}
        size="small"
        onChange={handleTableChange}
        columns={[
          {
            key: 'sourceType',
            title: t('knowledgePanel.columnType'),
            width: 64,
            className: 'source-icon-cell',
            align: 'center',
            filters: [
              { text: t('knowledgePanel.typeFile'), value: 'file' },
              { text: t('knowledgePanel.typeUrl'), value: 'url' },
              { text: t('knowledgePanel.typeExperience'), value: 'experience' },
            ],
            filteredValue: filterSourceType !== 'all' ? [filterSourceType] : [],
            render: (_, record) => {
              const tag = SOURCE_TAGS[record.sourceType] || SOURCE_TAGS.file
              return <span style={{ fontSize: 14, color: tag.color }}>{tag.icon}</span>
            },
          },
          {
            key: 'title',
            title: t('knowledgePanel.columnName'),
            sorter: true,
            sortOrder: sortState?.key === 'title' ? (sortState.order === 'asc' ? 'ascend' : 'descend') : null,
            filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => (
              <div style={{ padding: 8 }}>
                <Input.Search
                  placeholder={t('knowledgePanel.searchPlaceholder')}
                  value={selectedKeys[0] as string || ''}
                  onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                  onSearch={(value) => { confirm(); handleSearch(value) }}
                  allowClear
                  onClear={() => { clearFilters?.(); handleSearch('') }}
                  style={{ width: 200 }}
                  size="small"
                />
              </div>
            ),
            filterIcon: (filtered: boolean) => (
              <SearchOutlined style={{ fontSize: 14, color: filtered ? '#1677ff' : undefined }} />
            ),
            filteredValue: searchQuery ? [searchQuery] : [],
            render: (_, record) => (
              <div>
                <Text style={{ fontSize: 13, lineHeight: '20px' }} ellipsis>
                  {record.title || record.filePath}
                </Text>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', lineHeight: '16px' }} ellipsis={{ tooltip: record.filePath }}>
                  {record.filePath}
                </Text>
              </div>
            ),
          },
          {
            key: 'createdAt',
            dataIndex: 'createdAt',
            title: t('knowledgePanel.columnDate'),
            width: 130,
            className: 'date-cell',
            align: 'center',
            sorter: true,
            sortOrder: sortState?.key === 'createdAt' ? (sortState.order === 'asc' ? 'ascend' : 'descend') : null,
            filteredValue: null,
            render: (_, record) => (
              <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                {new Date(record.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </Text>
            ),
          },
          {
            key: 'status',
            title: t('knowledgePanel.columnStatus'),
            width: 64,
            className: 'status-cell',
            align: 'center',
            filters: [
              { text: t('knowledgePanel.statusRaw'), value: 'raw' },
              { text: t('knowledgePanel.statusCompiled'), value: 'compiled' },
            ],
            filteredValue: filterStatus !== 'all' ? [filterStatus] : [],
            render: (_, record) => {
              if (compilingFileIds.has(record.id)) {
                return (
                  <Tooltip title="正在编译">
                    <LoadingOutlined style={{ fontSize: 15, color: '#52c41a' }} />
                  </Tooltip>
                )
              }
              if (queuedFileIds.has(record.id)) {
                return (
                  <Tooltip title="等待编译">
                    <ClockCircleOutlined style={{ fontSize: 15, color: '#faad14' }} />
                  </Tooltip>
                )
              }
              if (record.status === 'compiled') {
                return (
                  <Tooltip title="完成编译">
                    <CheckCircleOutlined style={{ fontSize: 15, color: '#aaa' }} />
                  </Tooltip>
                )
              }
              return (
                <Tooltip title="开始编译">
                  <PlayCircleOutlined
                    style={{ fontSize: 15, color: '#52c41a', cursor: 'pointer' }}
                    onClick={() => enqueueCompileOne(record.id)}
                  />
                </Tooltip>
              )
            },
          },
          {
            key: 'actions',
            title: t('knowledgePanel.columnActions'),
            width: 96,
            className: 'actions-cell',
            filteredValue: null,
            render: (_, record) => (
              <Space size={0}>
                <Tooltip title="预览">
                  <Button type="text" size="small" icon={<FileSearchOutlined />} style={{ color: '#aaa' }} onClick={() => handleOpenRaw(record)} />
                </Tooltip>
                {(record.sourcePath || record.sourceUrl) && (
                  <Tooltip title={record.sourceType === 'url' ? '在浏览器中打开' : '打开原始文件'}>
                    <Button type="text" size="small" icon={<LinkOutlined />} style={{ color: '#aaa' }} onClick={() => handleOpenSource(record)} />
                  </Tooltip>
                )}
                <Tooltip title="删除">
                  <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: '#aaa' }} onClick={() => handleDelete(record)} />
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
    </div>
  )

  // ── Render: always show raw files content ──
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {rawTab}
    </div>
  )
})

export default KnowledgePanel
