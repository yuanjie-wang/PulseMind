import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Typography, Space, Input, Modal, Tooltip, Table, Segmented, Dropdown, Select } from 'antd'
import {
  LinkOutlined,
  DeleteOutlined,
  FileTextOutlined,
  GlobalOutlined,
  BulbOutlined,
  StarOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  SearchOutlined,
  FileSearchOutlined,
  ReadOutlined,
  GroupOutlined,
  LoadingOutlined
} from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import { throttleTrailing } from '../../utils/throttle'
import { openInPreviewPane } from '../../stores/previewPaneStore'
import type { KnowledgeFile, KnowledgeBase, KnowledgeImportResult } from '../../../../shared/types/knowledge'
import { DEFAULT_BASE_ID } from '../../../../shared/types/knowledge'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import { compileQueue, enqueueCompileForFile } from './compile-queue'

// ── Module-level dual queue engine ──
//
// Import and compile run on independent queues (not serialized). Module-level
// state survives mount/unmount so running async loops can continue and notify
// the remounted component via registered callbacks.
//
// The compile queue itself lives in ./compile-queue: two of its producers are
// not the panel (App's startup compile, a chat card's 编译), so importing them
// from here would drag this file's whole subtree into the first-paint chunk.

// ── Import queue (supports both file paths and URLs) ──
type ImportItem = { type: 'file'; path: string; baseId?: string } | { type: 'url'; url: string; baseId?: string }
const _pendingImportItems: ImportItem[] = []
let _importRunning = false
let _importCurrent = 0
let _importTotal = 0

/** One worker fork per N files: importFiles → importLocalFiles →
 *  extractManyInWorker batches extraction into ONE extractor fork, so per-file
 *  calls paid a whole child_process.fork per path — thousands of forks for a
 *  folder import (「导入大批量文件时会卡死」). Chunking restores the batch
 *  primitive's intent; a base change or a URL breaks the run naturally. */
const IMPORT_CHUNK = 16

/** `push(...paths)` with an apply-spread: ~100k paths would blow the call
 *  argument stack (RangeError) before a single import runs. Push in slices. */
const ENQUEUE_CHUNK = 10_000

/** Coalesce list+stats reloads during a run — see utils/throttle. The import
 *  and compile queues used to fire a full reload after EVERY file. */
const REFRESH_THROTTLE_MS = 500

// Callbacks — registered by the component on mount, cleared on unmount.
let _onProgress: ((current: number, total: number) => void) | null = null
let _onRefresh: (() => void) | null = null
let _onResetProgress: (() => void) | null = null
let _onStateChange: ((state: KnowledgePanelState) => void) | null = null

/** The ONE refresh the import and compile queues call: leading edge, then at
 *  most one per REFRESH_THROTTLE_MS with a guaranteed trailing run, so a burst
 *  of 10k imports produces a handful of reloads and still lands the final
 *  state. Reading `_onRefresh` at fire time means an unmounted (nulled)
 *  callback is a no-op even if a timer survived. */
const _refreshThrottled = throttleTrailing(() => _onRefresh?.(), REFRESH_THROTTLE_MS)

/** Last path segment for failure messages — the renderer has no node:path. */
const nameOf = (p: string): string => p.split(/[\\/]/).pop() ?? p

const { Text } = Typography

export interface KnowledgePanelHandle {
  handleAddFile: (importBaseId?: string) => Promise<void>
  handleAddFolder: (importBaseId?: string) => Promise<void>
  setShowUrlInput: (v: boolean) => void
  enqueueImport: (filePaths: string[], importBaseId?: string) => Promise<void>
  enqueueUrlImport: (url: string, importBaseId?: string) => void
  enqueueCompileAll: () => Promise<void>
  handleRebuildWiki: () => Promise<void>
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
  /** The base this panel is scoped to (the left rail's selection). Every
   *  query, import, search and maintenance call threads it — the selection IS
   *  the scope. Absent = the default base. */
  baseId?: string
  onStateChange?: (state: KnowledgePanelState) => void
}

const SOURCE_TAGS: Record<string, { color: string; icon: React.ReactNode }> = {
// Source-type and entity-tag hues are DATA LEGEND colours (they distinguish
// content types inside wiki output), not theme surfaces — they stay literals
// on both grounds, like the chip hue and the status dots.
  file: { color: '#858585', icon: <FileTextOutlined /> },
  url: { color: '#84b9ea', icon: <GlobalOutlined /> },
  experience: { color: 'orange', icon: <BulbOutlined /> },
  favorite: { color: '#faad14', icon: <StarOutlined /> }
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
  source_msg_id: '消息 ID',
  saved: '录入时间',
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
  favorite: '#faad14',
}

function CompiledPreview({ content }: { content: string }): React.ReactElement {
  const [meta, body] = splitFrontmatter(content)

  return (
    <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
      {Object.keys(meta).length > 0 && (
        <div style={{ marginBottom: 16, padding: '12px 16px', background: 'var(--pm-row-hover)', borderRadius: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(meta).map(([key, val]) => (
              <span key={key}>
                <span style={{ color: 'var(--pm-text-muted)', marginRight: 4, whiteSpace: 'nowrap' }}>{FRONTMATTER_LABELS[key] || key}:</span>
                {key === 'type' || key === 'source_type' ? (
                  <span style={{
                    display: 'inline-block',
                    padding: '0 6px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--pm-ink-contrast)',
                    background: FRONTMATTER_COLORS[val] || 'var(--pm-text-secondary)',
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

const KnowledgePanel = React.forwardRef<KnowledgePanelHandle, KnowledgePanelProps>(function KnowledgePanel({ knowledgeManager, baseId, onStateChange }, ref): React.ReactElement {
  const { t } = useTranslation()
  
  // One resolved scope for the whole component: the selection IS the scope.
  const scopedBaseId = baseId ?? DEFAULT_BASE_ID
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
  // K7②: 按文件名(默认)或全文检索。全文走 K5 后的排序检索(svcSearchContent)。
  const [searchMode, setSearchMode] = useState<'name' | 'fulltext'>('name')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [sortState, setSortState] = useState<{ key: string; order: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(1)
  const pageSize = 50
  const [totalItems, setTotalItems] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Bases for the row/batch assigns; refreshed with the file list so an
  // assign made elsewhere (toolbar menu) is visible on the next reload.
  const [bases, setBases] = useState<KnowledgeBase[]>([])

  // ── Progress ──
  const [, setImportProgress] = useState<{ current: number; total: number } | null>(null)

  const loadFiles = useCallback(async () => {
    try {
      // 全文模式：先检索内容命中的文件 id，再按 id 过滤当页列表（排序检索本身
      // 就是 K5 后的排序检索(svcSearchContent)；命中范围限定在当前库）。
      let fulltextIds: Set<string> | null = null
      if (searchQuery && searchMode === 'fulltext') {
        try {
          const matches = await knowledgeManager.searchContent(searchQuery, scopedBaseId)
          fulltextIds = new Set(matches.map((m) => m.id))
          if (fulltextIds.size === 0) {
            setFiles([]); setTotalItems(0)
            const currentStats = await knowledgeManager.getStats(scopedBaseId)
            setStats(currentStats)
            return
          }
        } catch { fulltextIds = null }
      }
      const [result, currentStats] = await Promise.all([
        knowledgeManager.listFilesAdvanced({
          baseId: scopedBaseId,
          ...(searchQuery && searchMode === 'name' && { search: searchQuery }),
          ...(filterSourceType !== 'all' && { sourceType: filterSourceType as KnowledgeFile['sourceType'] }),
          ...(filterStatus !== 'all' && { status: filterStatus as 'raw' | 'compiled' }),
          ...(sortState && { sortBy: sortState.key as 'createdAt' | 'title' | 'status' }),
          ...(sortState && { sortOrder: sortState.order }),
          page,
          pageSize
        }),
        knowledgeManager.getStats(scopedBaseId)
      ])
      const items = fulltextIds ? result.items.filter((f) => fulltextIds!.has(f.id)) : result.items
      setFiles(items)
      setTotalItems(fulltextIds ? items.length : result.total)
      setStats(currentStats)
      try { setBases(await knowledgeManager.listBases()) } catch { /* keep the last list */ }
    } catch (err) {
      console.error('[KnowledgePanel] Failed to load files:', err)
    }
  }, [knowledgeManager, scopedBaseId, searchQuery, searchMode, filterSourceType, filterStatus, sortState, page, pageSize])

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
    // One loadFiles per refresh: it already fetches getStats (Promise.all'd
    // with the list) and the reportState effect pushes stats to the parent —
    // the second getStats + manual push that used to live here doubled every
    // refresh's work (and getStats readdirs the base's wiki dir recursively).
    _onRefresh = async () => {
      await loadFilesRef.current()
    }
    // The compile queue's three notifications. They carry React state, so they
    // live for exactly as long as this mount does — the queue itself keeps its
    // `pending` across unmounts and picks up where it left off.
    compileQueue.sinks.onFileStatusChange = (fileId, status) => {
      if (status === 'compiling') {
        setCompilingFileIds(prev => new Set(prev).add(fileId))
      } else {
        setCompilingFileIds(prev => { const next = new Set(prev); next.delete(fileId); return next })
        setQueuedFileIds(prev => { const next = new Set(prev); next.delete(fileId); return next })
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status } : f))
      }
    }
    compileQueue.sinks.onMarkQueued = (fileId) => {
      setQueuedFileIds(prev => new Set(prev).add(fileId))
    }
    // The same throttled refresh the import loop calls — one list, one stats
    // push, coalesced to REFRESH_THROTTLE_MS.
    compileQueue.sinks.onRefresh = () => _refreshThrottled.schedule()
    _onResetProgress = () => {
      setImportProgress(null)
    }

    // Sync progress via _onProgress so parent gets correct values immediately
    if (_importRunning) {
      _onProgress(_importCurrent, _importTotal)
    }

    // Restore the currently-compiling file's loading state
    if (compileQueue.running && compileQueue.compilingFileId) {
      setCompilingFileIds(new Set([compileQueue.compilingFileId]))
    }

    // On remount, repopulate queuedFileIds from module-level queues and
    // start the compile queue if there are pending items (e.g. startup compile).
    if (compileQueue.pending.length > 0) {
      setQueuedFileIds(new Set(compileQueue.pending))
      if (!compileQueue.running) {
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
      _onRefresh = null
      _onResetProgress = null
      _onStateChange = null
      // A pending trailing refresh belongs to this mount — drop it with the
      // callbacks instead of letting the timer outlive the component.
      _refreshThrottled.cancel()
      compileQueue.sinks.onFileStatusChange = null
      compileQueue.sinks.onMarkQueued = null
      compileQueue.sinks.onRefresh = null
    }
  }, [])

  const handleAddFile = async (importBaseId?: string) => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Supported Documents',
        extensions: ['txt', 'md', 'html', 'pdf', 'docx', 'pptx', 'xlsx']
      }]
    })
    if (result.canceled || result.filePaths.length === 0) return
    enqueueImport(result.filePaths, importBaseId ?? scopedBaseId)
  }

  const handleAddFolder = async (importBaseId?: string) => {
    const dialogResult = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory']
    })
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return

    const folderPath = dialogResult.filePaths[0]
    // This whole path used to be unguarded: the scan result arrived as a bare
    // array (the IPC returned `string[]` while the bridge declares the object),
    // the destructure produced undefined, prepareImport threw — and with no
    // catch the user just saw 「选完文件夹没反应」.
    try {
      const { fileCount, filePaths } = await knowledgeManager.scanFolder(folderPath)
      if (fileCount === 0) {
        notify.info('文件夹中没有可导入的文件')
        return
      }

      const { existing, new: newFiles } = await knowledgeManager.prepareImport(filePaths, scopedBaseId)

      Modal.confirm({
        title: '导入文件夹',
        content: `找到 ${filePaths.length} 个文件（${newFiles.length} 个新文件${existing.length > 0 ? `，${existing.length} 个已存在` : ''}），是否开始导入？`,
        okText: '开始导入',
        cancelText: t('common.cancel'),
        onOk: () => {
          if (newFiles.length > 0) enqueueImport(newFiles, importBaseId ?? scopedBaseId)
        }
      })
    } catch (err) {
      console.error('[KnowledgePanel] Folder import failed:', err)
      notify.error(`导入文件夹失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleAddUrl = async () => {
    const url = urlInput.trim()
    if (!url) return
    if (!/^https?:\/\/.+/.test(url)) {
      notify.error('不支持的链接格式，仅支持 http/https 链接')
      return
    }

    // Pre-check duplicates before enqueuing — scoped to THIS base: under the
    // rail's isolation the same URL may legitimately live in two bases.
    const allFiles = await knowledgeManager.listFiles()
    const existing = allFiles.find(f => f.baseId === scopedBaseId && f.sourceType === 'url' && f.sourceUrl === url)
    if (existing) {
      Modal.confirm({
        title: '已导入过该链接',
        content: `"${url}" 已经导入过当前知识库，是否重新导入？`,
        okText: '重新导入',
        cancelText: '取消',
        onOk: async () => {
          try {
            await knowledgeManager.deleteFile(existing.id)
          } catch { /* ignore */ }
          setUrlInput('')
          setShowUrlInput(false)
          enqueueUrlImport(url, scopedBaseId)
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
    enqueueUrlImport(url, scopedBaseId)
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
  const enqueueImport = useCallback(async (filePaths: string[], importBaseId?: string) => {
    if (filePaths.length === 0) return
    const { existing, new: newFiles } = await knowledgeManager.prepareImport(filePaths, importBaseId ?? scopedBaseId)

    if (newFiles.length === 0) {
      if (existing.length > 0) notify.info('所有文件均已导入')
      return
    }

    // G4: the toolbar's target base rides each item — a batch never mixes
    // bases, because the pick was made once for the whole import. The fallback
    // is the panel's own scope (the rail's selection), not a global default.
    // Sliced pushes: one `push(...all)` is an apply-spread over the argument
    // list and overflows the stack on a big enough folder.
    const targetBase = importBaseId ?? scopedBaseId
    for (let i = 0; i < newFiles.length; i += ENQUEUE_CHUNK) {
      _pendingImportItems.push(
        ...newFiles.slice(i, i + ENQUEUE_CHUNK).map(p => ({ type: 'file' as const, path: p, baseId: targetBase }))
      )
    }
    // Update progress immediately if queue is already running
    if (_importRunning) {
      _importTotal += newFiles.length
      _onProgress?.(_importCurrent, _importTotal)
    }
    runImportQueueRef.current()
  }, [knowledgeManager, scopedBaseId])

  /** Enqueue a URL for import. The URL is already validated and deduplicated by the caller. */
  const enqueueUrlImport = useCallback((url: string, importBaseId?: string) => {
    _pendingImportItems.push({ type: 'url', url, baseId: importBaseId ?? scopedBaseId })
    // Update progress immediately if queue is already running
    if (_importRunning) {
      _importTotal += 1
      _onProgress?.(_importCurrent, _importTotal)
    }
    runImportQueueRef.current()
  }, [scopedBaseId])

  /** Enqueue a single file for compilation. */
  const enqueueCompileOne = enqueueCompileForFile

  /** Enqueue the current base's raw files for compilation ("compile all").
   *  Scoped: with the rail's isolation this must never touch another base. */
  const enqueueCompileAll = useCallback(async () => {
    const { items } = await knowledgeManager.listFilesAdvanced({ status: 'raw', baseId: scopedBaseId })
    if (items.length === 0) {
      notify.info(t('knowledgePanel.nothingToCompile'))
      return
    }
    for (const f of items) enqueueCompileOne(f.id)
  }, [knowledgeManager, enqueueCompileOne, scopedBaseId, notify, t])

  /** R4 (PLAN-knowledge-groups): wipe every compiled page in the CURRENT base
   *  and recompile its sources from scratch — the one-shot repair for
   *  junk/溯源-less pages. Manual wiki edits are lost (the confirm says so).
   *  An explicit user action, so the queue is refilled regardless of
   *  knowledge.autoCompile — that gate is for imports, not for this. */
  const handleRebuildWiki = useCallback(async (): Promise<void> => {
    if (!knowledgeManager.canCompile) {
      notify.warning(t('knowledgePanel.llmNotConfigured'))
      return
    }
    Modal.confirm({
      title: '重建 Wiki',
      content: '将清空当前知识库编译产生的 Wiki 页面，并重新编译它的所有源文件。你在 Wiki 页面上的手工修改会丢失。',
      okText: '重建',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const { clearedPages, resetSources } = await knowledgeManager.rebuildWiki(scopedBaseId)
          notify.success(`已清空 ${clearedPages} 个 Wiki 页面，${resetSources} 个源待重编`)
          await loadFilesRef.current()
          const { items } = await knowledgeManager.listFilesAdvanced({ status: 'raw', baseId: scopedBaseId })
          for (const f of items) enqueueCompileOne(f.id)
        } catch (err) {
          console.error('[KnowledgePanel] Rebuild failed:', err)
          notify.error('重建失败')
        }
      },
    })
  }, [knowledgeManager, enqueueCompileOne, notify, scopedBaseId, t])

  // ── Independent queue processors ──
  //
  // Import and compile run independently (not serialized). Each is gated by its
  // own running flag. Module-level callbacks bridge back to React state.
  // Refs break the circular dependency between the two useCallback functions.

  const runImportQueueRef = useRef<() => Promise<void>>(async () => {})
  const runCompileQueueRef = useRef<() => Promise<void>>(async () => {})

  /** Process the import queue — supports both file paths and URLs.
   *  Files ride in IMPORT_CHUNK batches (ONE knowledgeManager.importFiles call,
   *  hence ONE extractor fork per batch instead of one per file); the D7
   *  autoCompile gate is read once per run, not once per file; refreshes and
   *  progress go through the coalesced paths above. Failures are counted and
   *  reported once at the end — the old per-item swallow-everything catch
   *  showed a full green bar for a run where every file had died. */
  const runImportQueue = useCallback(async () => {
    if (_importRunning) return
    if (_pendingImportItems.length === 0) return

    _importRunning = true
    _importCurrent = 0
    _importTotal = _pendingImportItems.length

    _onResetProgress?.()
    _onProgress?.(0, _importTotal)

    // D7: imports only auto-compile when the setting is on — the default is
    // manual (编译按钮 / 编译全部). Read once for the whole run.
    let autoCompile = false
    try {
      const appSettings = await window.electronAPI.getSettings()
      autoCompile = !!appSettings?.knowledge?.autoCompile
    } catch { /* setting unreadable — stay manual */ }

    let failed = 0
    let firstError: string | null = null
    const noteFailure = (msg: string): void => {
      failed++
      if (firstError === null) firstError = msg
    }
    const settle = (count: number): void => {
      // Dynamic total handles mid-batch additions (a URL enqueued mid-run).
      _importCurrent += count
      _importTotal = _importCurrent + _pendingImportItems.length
      _onProgress?.(_importCurrent, _importTotal)
      _refreshThrottled.schedule()
    }

    while (_pendingImportItems.length > 0) {
      const head = _pendingImportItems[0]!

      if (head.type === 'url') {
        _pendingImportItems.shift()
        try {
          const result = await knowledgeManager.importUrl(head.url, head.baseId)
          if (result.success && result.file) {
            if (autoCompile) enqueueCompileForFile(result.file.id)
          } else {
            noteFailure(`${head.url}: ${result.error ?? '导入失败'}`)
          }
        } catch (err) {
          noteFailure(`${head.url}: ${err instanceof Error ? err.message : String(err)}`)
        }
        settle(1)
        continue
      }

      // Take a run of consecutive same-base file items → one importFiles call.
      const chunkBase = head.baseId
      const chunk: string[] = []
      while (chunk.length < IMPORT_CHUNK && _pendingImportItems.length > 0) {
        const next = _pendingImportItems[0]
        if (!next || next.type !== 'file' || next.baseId !== chunkBase) break
        _pendingImportItems.shift()
        chunk.push(next.path)
      }

      let results: KnowledgeImportResult[]
      try {
        results = await knowledgeManager.importFiles(chunk, chunkBase)
      } catch (err) {
        // The whole chunk was already shifted off the queue — account for every
        // path in it or the progress bar never reaches 100%.
        noteFailure(`${chunk.length} 个文件批量导入失败：${err instanceof Error ? err.message : String(err)}`)
        settle(chunk.length)
        continue
      }
      for (let i = 0; i < chunk.length; i++) {
        const result = results[i]
        if (result?.success && result.file) {
          if (autoCompile) enqueueCompileForFile(result.file.id)
        } else {
          noteFailure(`${nameOf(chunk[i])}: ${result?.error ?? '导入失败'}`)
        }
      }
      settle(chunk.length)
    }

    if (failed > 0) {
      notify.warning(`导入结束：${failed} 个文件失败${firstError ? `（${firstError}）` : ''}`)
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
    if (compileQueue.running || !knowledgeManager.canCompile) return
    if (compileQueue.pending.length === 0) return

    compileQueue.running = true

    while (compileQueue.pending.length > 0) {
      const fileId = compileQueue.pending.shift()!
      compileQueue.compilingFileId = fileId
      compileQueue.sinks.onFileStatusChange?.(fileId, 'compiling')
      let lastError: unknown
      let compiled = false
      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 3000))
        try {
          const result = await knowledgeManager.compileFile(fileId)
          if (result.ok && result.written > 0) {
            compiled = true
            compileQueue.sinks.onFileStatusChange?.(fileId, 'compiled')
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
      // Failure/no-key is raw and retryable, not an eternal loading spinner.
      if (!compiled) compileQueue.sinks.onFileStatusChange?.(fileId, 'raw')
      compileQueue.compilingFileId = null
      compileQueue.sinks.onRefresh?.()
    }

    compileQueue.running = false

    // If new items were added during processing, pick them up
    if (compileQueue.pending.length > 0) {
      runCompileQueueRef.current()
    }
  }, [knowledgeManager])

  // Wire up refs to avoid circular dependency between the two callbacks.
  // Done in an effect (after render) so the refs hold the latest callbacks
  // for event handlers, without mutating them during render. Writing refs in
  // effects is the standard React pattern; the immutability rule flags it
  // because the assigned callbacks are hook return values.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    runImportQueueRef.current = runImportQueue
    // eslint-disable-next-line react-hooks/immutability
    runCompileQueueRef.current = runCompileQueue
    compileQueue.wake = () => { void runCompileQueueRef.current() }
    // This runs after the refs are wired; the earlier mount effect sees the
    // initial no-op ref. Also retry retained raw work when config becomes usable.
    if (knowledgeManager.canCompile) compileQueue.wake()
    return () => { compileQueue.wake = null }
  })

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
          compileQueue.pending.length = 0
          _importRunning = false
          _importCurrent = 0
          _importTotal = 0
          compileQueue.running = false
          compileQueue.compilingFileId = null
          notify.success(`已清空 ${deletedRaw} 个源文件、${deletedWiki} 个编译文件`)
        } catch (err) {
          console.error('[KnowledgePanel] Reset failed:', err)
          notify.error('重置失败')
        }
      }
    })
  }

  // Expose handlers to parent (CentersPage for the toolbar menus)
  React.useImperativeHandle(ref, () => ({
    handleAddFile,
    handleAddFolder,
    setShowUrlInput,
    enqueueImport,
    enqueueUrlImport,
    enqueueCompileAll,
    handleRebuildWiki,
    handleReset,
  }), [handleAddFile, handleAddFolder, enqueueImport, enqueueUrlImport, enqueueCompileAll, handleRebuildWiki, handleReset])

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
    onStateChange(state)
  }, [stats, knowledgeManager.canCompile, onStateChange])

  React.useEffect(() => {
    if (!onStateChange) return
    const state: KnowledgePanelState = {
      importProgress: _importRunning ? { current: _importCurrent, total: _importTotal } : null,
      stats,
      isImporting: _importRunning,
      canCompile: knowledgeManager.canCompile,
    }
    const key = JSON.stringify(state)
    if (key !== prevStateRef.current) {
      // Ref is a mutable container by design; the immutability rule over-applies.
      // eslint-disable-next-line react-hooks/immutability
      prevStateRef.current = key
      onStateChange(state)
    }
  }, [reportState])

  /** Open the raw file content in a preview modal. */
  const handleOpenRaw = async (file: KnowledgeFile) => {
    try {
      const content = await knowledgeManager.readRawContent(file.filePath, file.baseId)
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '4px 12px', background: 'var(--pm-wash)', borderRadius: 4 }}>
          <Text style={{ fontSize: 12, color: 'var(--pm-text-secondary)' }}>
            {t('knowledgePanel.selectedCount', { n: selectedIds.size })}
          </Text>
          <Button size="small" type="primary" ghost onClick={handleBatchCompile} disabled={!files.some(f => selectedIds.has(f.id) && f.status === 'raw')}>
            {t('knowledgePanel.batchCompile')}
          </Button>
          <Button size="small" danger onClick={handleBatchDelete}>
            {t('knowledgePanel.batchDelete')}
          </Button>
          {/* G3: move the whole selection into a base in one IPC call. */}
          <Select<string>
            size="small"
            style={{ minWidth: 150 }}
            placeholder="移动到知识库…"
            value={undefined}
            onChange={async (baseId) => {
              try {
                await knowledgeManager.setFilesBase(Array.from(selectedIds), baseId)
                notify.success('已移动到知识库')
                setSelectedIds(new Set())
                loadFiles()
              } catch (err) {
                console.error('[KnowledgePanel] Batch assign failed:', err)
                notify.error('分配失败')
              }
            }}
            options={bases.map((b) => ({ value: b.id, label: b.name }))}
          />
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
        .knowledge-table .ant-pagination .ant-pagination-item a { color: var(--pm-ink) !important; }
        .knowledge-table .ant-pagination .ant-pagination-item-active { border-color: var(--pm-ink) !important; }
        .knowledge-table .ant-pagination .ant-pagination-item-active a { color: var(--pm-ink) !important; font-weight: 700 !important; }
        .knowledge-table .ant-pagination .ant-pagination-prev button,
        .knowledge-table .ant-pagination .ant-pagination-next button { color: var(--pm-ink) !important; }
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
              { text: t('knowledgePanel.typeFavorite'), value: 'favorite' },
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
                {/* R1 (PLAN-knowledge-groups): the mode switch the full-text
                    wiring always needed — without it setSearchMode had zero
                    call sites and mode=fulltext was unreachable. searchMode is
                    a loadFiles dep, so flipping it re-queries by itself. */}
                <Segmented
                  size="small"
                  block
                  value={searchMode}
                  onChange={(value) => setSearchMode(value as 'name' | 'fulltext')}
                  options={[
                    { label: t('knowledgePanel.searchModeName'), value: 'name' },
                    { label: t('knowledgePanel.searchModeFulltext'), value: 'fulltext' },
                  ]}
                  style={{ marginBottom: 8 }}
                />
                <Input.Search
                  placeholder={searchMode === 'fulltext' ? t('knowledgePanel.searchFulltextPlaceholder') : t('knowledgePanel.searchPlaceholder')}
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
              <SearchOutlined style={{ fontSize: 14, color: filtered ? 'var(--pm-link)' : undefined }} />
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
                    <LoadingOutlined style={{ fontSize: 15, color: 'var(--pm-success-status)' }} />
                  </Tooltip>
                )
              }
              if (queuedFileIds.has(record.id)) {
                return (
                  <Tooltip title="等待编译">
                    <ClockCircleOutlined style={{ fontSize: 15, color: 'var(--pm-gold-accent)' }} />
                  </Tooltip>
                )
              }
              if (record.status === 'compiled') {
                return (
                  <Tooltip title="完成编译">
                    <CheckCircleOutlined style={{ fontSize: 15, color: 'var(--pm-text-soft)' }} />
                  </Tooltip>
                )
              }
              return (
                <Tooltip title="开始编译">
                  <PlayCircleOutlined
                    style={{ fontSize: 15, color: 'var(--pm-success-status)', cursor: 'pointer' }}
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
                {/* G3: one click-opens-a-menu assign per row. */}
                <Dropdown
                  menu={{
                    items: bases.filter((b) => b.id !== record.baseId).map((b) => ({ key: b.id, label: b.name })),
                    onClick: async ({ key }) => {
                      try {
                        await knowledgeManager.setFileBase(record.id, key)
                        loadFiles()
                      } catch (err) {
                        console.error('[KnowledgePanel] Assign failed:', err)
                        notify.error('分配失败')
                      }
                    },
                  }}
                  trigger={['click']}
                >
                  <Tooltip title="移动到知识库">
                    <Button type="text" size="small" icon={<GroupOutlined />} style={{ color: 'var(--pm-text-soft)' }} />
                  </Tooltip>
                </Dropdown>
                <Tooltip title="预览">
                  <Button type="text" size="small" icon={<FileSearchOutlined />} style={{ color: 'var(--pm-text-soft)' }} onClick={() => handleOpenRaw(record)} />
                </Tooltip>
                {record.wikiOutputs && record.wikiOutputs.length > 0 && (
                  <Tooltip title="查看编译结果">
                    <Button
                      type="text"
                      size="small"
                      icon={<ReadOutlined />}
                      style={{ color: 'var(--pm-text-soft)' }}
                      onClick={() => void (async () => {
                        try {
                          // wikiOutputs are relative to the file's OWN base's
                          // wiki dir — the global dir is the default base's.
                          const wikiDir = await window.electronAPI.knowledgeGetWikiDir(record.baseId)
                          openInPreviewPane(`${wikiDir.replace(/\\/g, '/')}/${record.wikiOutputs![0]}`)
                        } catch { /* dir unavailable — no entry jump */ }
                      })()}
                    />
                  </Tooltip>
                )}
                {(record.sourcePath || record.sourceUrl) && (
                  <Tooltip title={record.sourceType === 'url' ? '在浏览器中打开' : '打开原始文件'}>
                    <Button type="text" size="small" icon={<LinkOutlined />} style={{ color: 'var(--pm-text-soft)' }} onClick={() => handleOpenSource(record)} />
                  </Tooltip>
                )}
                <Tooltip title="删除">
                  <Button type="text" size="small" icon={<DeleteOutlined />} style={{ color: 'var(--pm-text-soft)' }} onClick={() => handleDelete(record)} />
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
