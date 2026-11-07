// ── 工作区内容搜索（PLAN-project-ide 刀二，2026-10-31）──
//
// 沉浸窗口左卡的整卡面板：项目级全文搜索，随包 rg（svcSearchWorkspace）固定
// 串检索。只读通道——与 readFile 同类免确认，键入即搜（防抖 400ms）不弹窗。
// 结果行 `path:line:text`，点击 → openInPreviewPane reveal 到行（rg 自己印
// 的行号是真坐标，与 read/edit/预览的同一套行号坐标系）。退出由左卡切换器
// 承担。
//
// 2026-11-01 用户裁定「只有沉浸模式提供全量的编辑和操作能力，普通模式保持
// 简洁」：树工具条的全文搜索按钮两形态都退场，曾经的 strip 变体（主窗树列
// 底条、帽 48% 高）随之再无消费面，一并删除——本组件只剩整卡形态，由
// WorkspacePane 的沉浸左卡切换器（文件 | 搜索）挂载。
//
// 2026-10-31 用户四连裁定（同日）：① 沉浸切换器文案改「文件/搜索」；② 大小写
// Aa 键去边框改胶囊（旧 1px 边框在深色下糊成一团）；③ 关闭搜索的 ✕ 移除——
// 沉浸左卡由切换器负责开合；④ 结果行重排：两行结构（路径+行号 / 匹配窗口
// 文本），命中词带 --pm-warn-bg 高亮（rg 是 -F 固定串，indexOf 即真坐标），
// 长行取「命中 ± 窗口」而非一刀切头 160。
//
// 诚实边界：帽截断（truncated）必须说出来——一张看起来完整的列表不能冒充
// 全量；`--sort path` 给结果确定性（跨两次输入相同前缀时行序稳定）。

import React, { useEffect, useState } from 'react'
import { Input, Spin, Tooltip } from 'antd'
import { openInPreviewPane } from '../../stores/previewPaneStore'
import { parseSearchLine, type WorkspaceSearchRow } from '../../../../shared/workspace-search'

const SEARCH_DEBOUNCE_MS = 400
/** 防抖后仍要求的最小长度——单字符全项目检索的噪声没有消费价值。 */
const MIN_QUERY_LEN = 2
const DEFAULT_MAX_RESULTS = 200

interface Props {
  workspaceDir: string
}

/** One search generation's result. Idle (too-short query) is DERIVED in the
 *  render — the effect never resets state back, so a shortening query cannot
 *  leave the previous query's hits on screen and the effect body carries a
 *  single synchronous setState (the busy flip). */
interface SearchGen {
  rows: WorkspaceSearchRow[] | null // null = still nothing settled for this query
  truncated: boolean
  error: string | null
}
const IDLE_GEN: SearchGen = { rows: null, truncated: false, error: null }

/** 结果行/大小写键的样式（类名选择器：hover 与 [data-on] 态内联写不了，
 *  WorkspaceTabStrip 注入 <style> 的同款手法；`.pm-search-*` 前缀自隔离）。 */
const SEARCH_CSS = `
.pm-search-aa { border: none; background: transparent; cursor: pointer; flex: none;
  font-size: 11px; line-height: 16px; padding: 1px 7px; border-radius: 999px; color: var(--pm-text-faint); }
.pm-search-aa:hover { background: var(--pm-hover); color: var(--pm-text-quiet); }
.pm-search-aa[data-on='true'] { background: var(--pm-tile-soft); color: var(--pm-link); font-weight: 600; }
.pm-search-hit { display: block; width: 100%; text-align: left; border: none; background: transparent;
  cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.pm-search-hit:hover { background: var(--pm-hover); }
.pm-search-hit-head { display: flex; align-items: baseline; gap: 2px; min-width: 0; }
.pm-search-hit-path { font-size: 11px; font-weight: 500; color: var(--pm-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-search-hit-line { font-family: Menlo, Consolas, monospace; font-size: 10px; color: var(--pm-text-faint); flex: none; }
.pm-search-hit-text { display: block; font-size: 11px; line-height: 1.5; color: var(--pm-text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
.pm-search-hit-mark { background: var(--pm-warn-bg); color: var(--pm-text); border-radius: 2px; padding: 0 1px; }
`

function SearchBody({ workspaceDir }: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [gen, setGen] = useState<SearchGen>(IDLE_GEN)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const active = debounced.length >= MIN_QUERY_LEN

  useEffect(() => {
    if (!active) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new query must drop the previous one's rows synchronously: showing stale hits under a fresh query is worse than one extra render (PreviewContent's load() disable, same shape)
    setBusy(true)
    void window.electronAPI
      .searchWorkspace({ query: debounced, dir: workspaceDir, caseSensitive, maxResults: DEFAULT_MAX_RESULTS })
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setGen({ rows: [], truncated: false, error: res.error ?? '搜索失败' })
        } else {
          setGen({
            rows: (res.lines ?? []).map(parseSearchLine).filter((r): r is WorkspaceSearchRow => r != null),
            truncated: res.truncated === true,
            error: null,
          })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setGen({ rows: [], truncated: false, error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [debounced, workspaceDir, caseSensitive, active])

  const shown = active ? gen : IDLE_GEN
  const runSearch = (): void => setDebounced(query.trim()) // 大小写切换后立即重跑，不等防抖

  // 结果行的匹配窗口：固定串检索（rg -F），indexOf 即真坐标；不区分大小写时
  // 两侧 lowercase 再找。命中 ±60/80 字符，窗口外省略号——长行不再一刀切头
  // 160（命中的常常在行中后段，切头会把命中本身切掉）。
  const windowedText = (raw: string): React.ReactNode => {
    const text = raw.trim()
    const idx = caseSensitive
      ? text.indexOf(debounced)
      : text.toLowerCase().indexOf(debounced.toLowerCase())
    if (idx < 0) return text.slice(0, 160)
    const start = Math.max(0, idx - 60)
    const end = Math.min(text.length, idx + debounced.length + 80)
    return (
      <>
        {start > 0 ? '…' : ''}
        {text.slice(start, idx)}
        <mark className="pm-search-hit-mark">{text.slice(idx, idx + debounced.length)}</mark>
        {text.slice(idx + debounced.length, end)}
        {end < text.length ? '…' : ''}
      </>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <style>{SEARCH_CSS}</style>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--pm-separator-faint)' }}>
        <Input
          size="small"
          autoFocus
          aria-label="搜索内容"
          placeholder="搜索（固定串）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={runSearch}
          allowClear
          style={{ flex: 1, minWidth: 0 }}
        />
        <Tooltip title={caseSensitive ? '区分大小写' : '忽略大小写'}>
          <button
            type="button"
            className="pm-search-aa"
            aria-label="区分大小写"
            aria-pressed={caseSensitive}
            data-on={caseSensitive}
            onClick={() => {
              setCaseSensitive((v) => !v)
              runSearch()
            }}
          >
            Aa
          </button>
        </Tooltip>
        {busy && <Spin size="small" />}
      </div>
      <div className="auto-hide-scroll" style={{ overflow: 'auto', minHeight: 0, padding: '4px 4px', fontSize: 11 }}>
        {shown.error != null ? (
          <div style={{ color: 'var(--pm-error)', padding: '4px 8px', whiteSpace: 'pre-wrap' }}>{shown.error}</div>
        ) : !active ? (
          <div style={{ color: 'var(--pm-text-faint)', padding: '4px 8px' }}>{`输入至少 ${MIN_QUERY_LEN} 个字符开始搜索`}</div>
        ) : shown.rows === null ? null : shown.rows.length === 0 ? (
          <div style={{ color: 'var(--pm-text-muted)', padding: '4px 8px' }}>无匹配（rg 尊重 .gitignore、跳过隐藏文件）</div>
        ) : (
          <>
            {shown.truncated && (
              <div style={{ color: 'var(--pm-text-faint)', padding: '2px 8px' }}>{`结果过多，仅显示前 ${shown.rows.length} 条——换个更具体的搜索词`}</div>
            )}
            {shown.rows.map((r, i) => (
              <button
                key={`${r.path}:${r.line}:${i}`}
                type="button"
                className="pm-search-hit"
                data-ws-search-hit
                title="在预览中打开"
                onClick={() => openInPreviewPane(r.path, { mode: 'line', line: r.line })}
              >
                <span className="pm-search-hit-head">
                  <span className="pm-search-hit-path" title={r.path}>
                    {r.path.startsWith(workspaceDir + '/') ? r.path.slice(workspaceDir.length + 1) : r.path}
                  </span>
                  <span className="pm-search-hit-line">{`:${r.line}`}</span>
                </span>
                <span className="pm-search-hit-text">{windowedText(r.text)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export function SearchPanel({ workspaceDir }: Props): React.ReactElement {
  return (
    <div
      data-ws-search-panel
      style={{
        // 整卡填充（沉浸左卡）；strip 变体的帽 48% 形态已随主窗入口退场。
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--pm-bg)',
      }}
    >
      <SearchBody key={workspaceDir} workspaceDir={workspaceDir} />
    </div>
  )
}
