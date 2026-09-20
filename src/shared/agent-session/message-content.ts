import type { AgentMessage, ContentBlock } from '../../renderer/src/types/agent'

/** Runtime tool fields and message stats have their own diff channels. */
const TOOL_USE_RUNTIME_FIELDS = ['status', 'exitCode', 'output', 'subConvId', 'planNodeId'] as const

/**
 * Block-level signature cache (PLAN-long-task-perf M2-T1, D3/E4). The content
 * signature is rebuilt on every engine notify, and before this cache that
 * meant JSON.stringify walking EVERY block of EVERY message, every time — the
 * B1 hotspot (8.5ms per notify at a 2.8MB session, 15.5ms at 5.6MB, times six
 * parallel sessions' notify cadence).
 *
 * The cache is keyed on the BLOCK OBJECT's identity, which is exactly the
 * mirror's identity contract (E4): engine-side content changes go through
 * object rebuilds, so "same reference ⇒ same content" holds for the content
 * layer — and where it deliberately does NOT hold (the runtime fields are
 * written in place, e.g. `approveTool`'s `block.status = 'running'`), the
 * signature EXCLUDES those fields, so a cached value stays correct across
 * in-place runtime writes by construction. Both halves are load-bearing: key
 * this by identity in the RUNTIME layer, or drop the exclusion table, and the
 * diff channels go silent the way the 执行状态未知 cascade did.
 *
 * The message signature is then a NEWLINE-JOIN of the cached block strings —
 * not a JSON.stringify OF them, which would re-serialize (and re-escape) every
 * cached byte on every notify and give the cache nothing back. JSON never
 * emits a raw newline (it escapes to the two characters backslash + n), so the
 * join is unambiguous, and the result keeps its old semantics: an opaque key
 * whose equality against a previous notify's value is the only thing any
 * consumer does with it. The join still allocates O(total bytes) — that is
 * inherent to whole-history diffing — but at memcpy speed, not a
 * walk-and-serialize.
 */
const blockSignatureCache = new WeakMap<object, string>()

function blockSignature(block: ContentBlock): string {
  const cached = blockSignatureCache.get(block)
  if (cached !== undefined) return cached
  let sig: string
  if (block.type === 'tool_use') {
    const content = { ...block } as Record<string, unknown>
    for (const runtime of TOOL_USE_RUNTIME_FIELDS) delete content[runtime]
    sig = JSON.stringify(content)
  } else {
    sig = JSON.stringify(block)
  }
  blockSignatureCache.set(block, sig)
  return sig
}

export function messageContentSignature(message: AgentMessage): string {
  return message.role + '\n' + message.contentBlocks.map(blockSignature).join('\n')
}
