// ── Preview pane ↔ agent-session sync (PLAN-preview-pane §设计4) ──
// Watches the agent-session event stream of the conversation on screen and
// drives the pane: a successful `write` auto-opens the file (D3, previewable
// kinds only — and since PLAN-ide-linkage 1b, so does a successful `edit`,
// because a reveal nobody can see is worth nothing), any successful write/edit
// bumps the matching tab's reload tick so it re-reads from disk. A completed
// edit additionally carries a reveal target (edit-reveal.ts): the preview
// scrolls to where the change landed. Tool inputs may be workspace-relative,
// so paths resolve the same way the executor resolves them main-side.
//
// Completion detection rides `tool_status` (in-place diffs emitted only for
// live transitions), while the write's input (file path, reveal) is remembered
// from the messages / tool_start events that carry it — restoring a finished
// conversation therefore never auto-opens anything.
//
// The reveal is derived AT INGEST time and only its small result (a line
// number or a ≤120-char anchor) is retained — never the raw old_str/new_str
// (write.content may reach 500K).

import { useEffect } from 'react'
import type { AgentEventData } from '../../../shared/agent-protocol/payloads'
import { resolvePreviewPath, shouldAutoOpen } from '../../../shared/preview/file-kind'
import { deriveEditReveal, deriveEditTargets, type EditRevealTarget } from '../../../shared/tool-display/edit-reveal'
import { usePreviewPaneStore } from '../stores/previewPaneStore'

export interface PaneFileEvent {
  toolUseId: string
  tool: 'write' | 'edit' | 'office_export' | 'export_document'
  path: string
  /** office_export forces the pane open (D9): the moment a deliverable is
   *  born is when the user wants to see it — office kinds would otherwise
   *  fail shouldAutoOpen, which is write's own heuristic, not a law. */
  force?: boolean
  /** Where the preview should land (edit only; write/export open from top). */
  reveal?: EditRevealTarget | null
  /** Multi-file diff: the remaining target files — reload bumps only. */
  extraPaths?: string[]
}

type KnownToolMeta = {
  name: string
  path: string
  reveal?: EditRevealTarget | null
  extraPaths?: string[]
  /** edit-only search/replace inputs (2026-11-01): lets the review diff
   *  rebuild the pre-change text when the pane did NOT hold the file
   *  (multiAll = replace every occurrence). Multi-file `diff` inputs have no
   *  such reconstruction — those show a review only if the pane held them. */
  reconstruct?: { mode: 'reconstruct'; oldStr: string; newStr: string; multiAll: boolean }
}

/** Input → tracked meta, shared by the tool_start and message-item ingest
 *  arms. A no-file_path edit can still name its target: a multi-file diff's
 *  first section is the reveal file, the rest ride extraPaths. */
function metaFromInput(name: string, input: Record<string, unknown> | null | undefined): KnownToolMeta | null {
  const reconstructOf = (): KnownToolMeta['reconstruct'] => {
    if (name !== 'edit') return undefined
    const oldStr = input?.old_str
    const newStr = input?.new_str
    // Empty new_str is a pure-deletion edit (review_20261103 中3): the old
    // guard let it through and `after.replace('', oldStr)` spliced the whole
    // document at the head — a document-scale fake diff. Reconstruct requires
    // both halves; reconstructPreChangeText re-guards defensively anyway.
    if (typeof oldStr !== 'string' || oldStr.length === 0 || typeof newStr !== 'string' || newStr.length === 0) return undefined
    return { mode: 'reconstruct' as const, oldStr, newStr, multiAll: input?.multi === true }
  }
  const filePath = input?.file_path
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    return { name, path: filePath, reveal: name === 'edit' ? deriveEditReveal(input) : undefined, reconstruct: reconstructOf() }
  }
  if (name === 'edit') {
    const targets = deriveEditTargets(input)
    if (targets) return { name, path: targets.path, reveal: targets.reveal, extraPaths: targets.extraPaths }
  }
  return null
}

/** Fold one agent event into `known` and return the file events it completes.
 *  Pure apart from the map it is handed — unit-tested. */
export function ingestAgentEvent(known: Map<string, KnownToolMeta>, data: AgentEventData): PaneFileEvent[] {
  if (data.type === 'messages' || data.type === 'messages_append') {
    const items = data.type === 'messages' ? data.messages : data.items
    for (const item of items as unknown[]) ingestMessageItem(known, item)
    return []
  }
  if (data.type === 'tool_start') {
    if (data.name === 'write' || data.name === 'edit' || data.name === 'office_export' || data.name === 'export_document') {
      const meta = metaFromInput(data.name, data.input as Record<string, unknown> | null | undefined)
      if (meta) known.set(data.toolUseId, meta)
    }
    return []
  }
  if (data.type === 'tool_status') {
    const fired: PaneFileEvent[] = []
    for (const u of data.updates) {
      if (u.status !== 'completed') continue
      if (u.exitCode !== undefined && u.exitCode !== 0) continue
      const meta = known.get(u.toolUseId)
      if (meta && (meta.name === 'write' || meta.name === 'edit' || meta.name === 'office_export' || meta.name === 'export_document')) {
        fired.push({
          toolUseId: u.toolUseId,
          tool: meta.name,
          path: meta.path,
          force: meta.name === 'office_export' || meta.name === 'export_document',
          reveal: meta.reveal,
          extraPaths: meta.extraPaths,
        })
      }
    }
    return fired
  }
  return []
}

function ingestMessageItem(known: Map<string, KnownToolMeta>, item: unknown): void {
  const blocks = (item as { contentBlocks?: unknown[] } | null)?.contentBlocks
  if (!Array.isArray(blocks)) return
  for (const raw of blocks) {
    const b = raw as { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
    if (b?.type !== 'tool_use' || !b.id) continue
    if (b.name !== 'write' && b.name !== 'edit' && b.name !== 'office_export' && b.name !== 'export_document') continue
    const meta = metaFromInput(b.name, b.input)
    if (meta) known.set(b.id, meta)
  }
}

/** ChatView-level effect: keep the pane reacting to the conversation on
 *  screen. Re-subscribes on conversation / workspace change. */
export function usePreviewPaneSync(conversationId: string | undefined, workspaceDir: string | undefined): void {
  useEffect(() => {
    const known = new Map<string, KnownToolMeta>()
    const fired = new Set<string>()
    return window.electronAPI.onAgentSessionEvent(({ sessionId, data }) => {
      if (sessionId !== conversationId) return
      for (const ev of ingestAgentEvent(known, data as AgentEventData)) {
        if (fired.has(ev.toolUseId)) continue
        fired.add(ev.toolUseId)
        const store = usePreviewPaneStore.getState()
        const abs = resolvePreviewPath(ev.path, workspaceDir)
        // Agent-change review diff (2026-11-01): fix the pre-change base at
        // EVENT time — the pane holding the file wins (loadedTexts = the
        // exact pre-change text, snapshotted NOW because the reload's own
        // read would overwrite it); otherwise stage the edit tool's
        // old_str/new_str reconstruction, which PreviewContent resolves once
        // the post-change read lands (before bumpReload — that read is what
        // the reconstruct pairs against).
        const meta = known.get(ev.toolUseId)
        const before = store.loadedTexts[abs]
        if (before !== undefined) {
          store.setAgentDiffBase(abs, before)
          store.setDiffVisible(abs, true)
        } else if (meta?.reconstruct) {
          store.setAgentDiffCapture(abs, meta.reconstruct)
          store.setDiffVisible(abs, true)
        }
        // 发射即弃（review_20261104 中5）：store 已接走自己的副本
        // （setAgentDiffCapture 由 resolve 侧消费、自行清理），known 里再留
        // 一份原始 old_str/new_str 就是会话生命周期内的纯滞留——违反本文件
        // 头「绝不留原始 old_str/new_str」的纪律。fired 集合已挡重发，删除
        // 只是让内存与纪律对齐。
        known.delete(ev.toolUseId)
        // D3's previewable-kind gate now serves edits too: the reveal is the
        // review moment, and it must not open a pane on a binary blob.
        if (ev.force || shouldAutoOpen(abs)) {
          store.openFile(sessionId, abs)
          // An already-open tab must re-read from disk too.
          store.bumpReload(abs)
        } else store.bumpReload(abs)
        for (const extra of ev.extraPaths ?? []) {
          store.bumpReload(resolvePreviewPath(extra, workspaceDir))
        }
        if (ev.reveal) store.requestReveal(abs, ev.reveal)
      }
    })
  }, [conversationId, workspaceDir])
}
