/** Display formatting shared by the panel transcript — the panel's copies of
 *  three helpers the desktop chat keeps private inside
 *  `components/chat/MessageGroup.tsx` (`toolBlockSummary`, `formatDuration`,
 *  `formatTokenCount`).
 *
 * They are copied rather than imported on purpose: MessageGroup imports antd,
 * `@ant-design/icons` and the renderer stores, and the panel runs as a content
 * script in the page's isolated world — importing that module would pull the
 * whole widget layer (and its DOM-injecting cssinjs runtime) into every page
 * load. If the chat's wording changes, change it here too. */

import type { ToolUseBlock } from '../../renderer/src/types/agent'

/** The human verb per tool (PLAN-tool-ux T1) — the panel's hardcoded-Chinese
 *  copy of the chat's `toolLabel.*` i18n keys (the panel has no i18n by
 *  ruling). If zh.ts's toolLabel section changes, change this table too. */
const TOOL_LABELS: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  list_dir: '浏览目录',
  search: '搜索内容',
  find: '查找文件',
  exec: '运行命令',
  install: '安装依赖',
  webfetch: '访问网页',
  recall: '本地检索',
  memory_save: '保存记忆',
  tool_result_search: '搜索工具结果',
  pick_skill: '查找技能',
  pick_tool: '启动工具',
  experience_read: '读取经验',
  experience_save: '保存经验',
  spawn_agent: '召唤专家',
  create_plan: '制定计划',
  advance_plan: '更新计划',
  git_status: '查看改动',
  git_diff: '查看差异',
  git_log: '查看提交历史',
  git_commit: '创建提交',
  git_restore: '还原改动',
  page_get_content: '阅读页面',
  page_scroll: '滚动页面',
  page_wait: '等待加载',
  page_click: '点击元素',
  page_input: '填写输入框',
  page_select: '选择选项',
  page_back: '返回上一页',
  page_execute_js: '执行页面脚本',
  browser: '打开网页',
  ask_user: '向你提问',
}

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? name
}

function firstLine(value: unknown, cap = 80): string {
  const text = String(value ?? '').split('\n', 1)[0]?.trim() ?? ''
  return text.length > cap ? text.slice(0, cap) : text
}

/** The object half, verbatim by family — mirrors the chat's tool-summary.ts
 *  (same fallbacks, same truncations; the chat's copy stays the reference). */
export function toolObjectSummary(block: ToolUseBlock): string {
  const input = block.input
  if (!input) return ''
  switch (block.name) {
    case 'exec': return ((input.command as string) || '').slice(0, 80)
    case 'read':
    case 'edit':
      return (input.file_path as string) || ''
    case 'write':
      return `${input.file_path || ''} (${
        ((input.content as string) || '').length > 0
          ? `${(((input.content as string) || '').length / 1024).toFixed(1)} KB`
          : '0 KB'
      })`
    case 'list_dir': return (input.dir_path as string) || ''
    case 'search':
    case 'find':
    case 'recall':
    case 'tool_result_search':
      return firstLine((input.query as string) || (input.pattern as string) || '', 60)
    case 'webfetch': {
      try { return new URL(input.url as string).host } catch { return (input.url as string) || '' }
    }
    case 'git_commit': return firstLine(input.message, 60)
    case 'create_plan': return firstLine(input.objective, 60)
    case 'ask_user': return ((input.prompt as string) || '').slice(0, 80)
    default: return ''
  }
}

/** One-line summary of a tool call — `动词 · 对象原文` (D1=C: exec's object
 *  stays the raw command; the approval row carries the command text on both
 *  surfaces). Unknown tools keep the `k=v` chain, description excluded. */
export function toolBlockSummary(block: ToolUseBlock): string {
  const label = toolDisplayName(block.name)
  const object = toolObjectSummary(block)
  if (!object) {
    const input = block.input
    if (!input) return label
    const entries = Object.entries(input).filter(([k]) => k !== 'description')
    if (entries.length === 0) return label
    const [k, v] = entries[0]
    const val = typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 37)}...` : v) : JSON.stringify(v).slice(0, 40)
    return `${label} · ${k}=${val}`
  }
  return `${label} · ${object}`
}

/** `950ms` / `1.4s` — the chat's duration format for the action row. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** `1,234` / `12.3k` — the chat's token format. */
export function formatTokenCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

/** `83%` — the chat's cache-hit rate off the message's own usage pair:
 *  inputTokens is the cached share's container (both adapters' streaming paths
 *  sum cache reads into it), so the pair alone prices the rate. */
export function cacheHitRate(hitTokens: number, inputTokens: number): string {
  return `${Math.round((hitTokens / inputTokens) * 100)}%`
}

/** Thinking-block preview line: the first line (truncated) plus a line count —
 *  the chat's ThinkingBlockView heuristic, so a collapsed block reads the same. */
export function thinkingPreview(thinking: string): string {
  const lines = thinking.split('\n')
  if (lines.length > 1) return `${lines[0].slice(0, 80)}… (${lines.length} lines)`
  return thinking.slice(0, 80) + (thinking.length > 80 ? '…' : '')
}
