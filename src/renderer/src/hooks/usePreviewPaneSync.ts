// ── Preview pane ↔ agent-session sync (PLAN-preview-pane §设计4) ──
// Watches the agent-session event stream of the conversation on screen and
// drives the pane: a successful `write` auto-opens the file (D3, previewable
// kinds only), any successful write/edit bumps the matching tab's reload
// tick so it re-reads from disk. Tool inputs may be workspace-relative, so
// paths resolve the same way the executor resolves them main-side.
//
// Completion detection rides `tool_status` (in-place diffs emitted only for
// live transitions), while the write's input (file path) is remembered from
// the messages / tool_start events that carry it — restoring a finished
// conversation therefore never auto-opens anything.

import { useEffect } from 'react'
import type { AgentEventData } from '../../../shared/agent-protocol/payloads'
import { resolvePreviewPath, shouldAutoOpen } from '../../../shared/preview/file-kind'
import { usePreviewPaneStore } from '../stores/previewPaneStore'

export interface PaneFileEvent {
  toolUseId: string
  tool: 'write' | 'edit'
  path: string
}

type KnownToolMeta = { name: string; path: string }

/** Fold one agent event into `known` and return the file events it completes.
 *  Pure apart from the map it is handed — unit-tested. */
export function ingestAgentEvent(known: Map<string, KnownToolMeta>, data: AgentEventData): PaneFileEvent[] {
  if (data.type === 'messages' || data.type === 'messages_append') {
    const items = data.type === 'messages' ? data.messages : data.items
    for (const item of items as unknown[]) ingestMessageItem(known, item)
    return []
  }
  if (data.type === 'tool_start') {
    if (data.name === 'write' || data.name === 'edit') {
      const input = data.input as { file_path?: unknown } | null | undefined
      if (input && typeof input.file_path === 'string') {
        known.set(data.toolUseId, { name: data.name, path: input.file_path })
      }
    }
    return []
  }
  if (data.type === 'tool_status') {
    const fired: PaneFileEvent[] = []
    for (const u of data.updates) {
      if (u.status !== 'completed') continue
      if (u.exitCode !== undefined && u.exitCode !== 0) continue
      const meta = known.get(u.toolUseId)
      if (meta && (meta.name === 'write' || meta.name === 'edit')) {
        fired.push({ toolUseId: u.toolUseId, tool: meta.name, path: meta.path })
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
    if (b.name !== 'write' && b.name !== 'edit') continue
    const path = b.input?.file_path
    if (typeof path === 'string') known.set(b.id, { name: b.name, path })
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
        if (ev.tool === 'write' && shouldAutoOpen(abs)) store.openFile(sessionId, abs)
        else store.bumpReload(abs)
      }
    })
  }, [conversationId, workspaceDir])
}
