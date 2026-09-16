import { describe, expect, it } from 'vitest'
import { resolvePlanNodeTarget } from '../src/renderer/src/agent/plan-node-target'
import type { AgentMessage, ToolUseBlock } from '../src/renderer/src/types/agent'
import type { PlanNode } from '../src/shared/types/plan'

/**
 * The DAG's node click (PLAN-workbench W12) — the reported 「点击任务模块，没有
 * 跳转」. What the click resolves to is decided here, off the plan node and the
 * transcript, and the interesting part is that the two carriers of the link are
 * not equally durable: the plan node's is persisted, the spawn block's is a wire
 * field that a restart (or compaction) drops.
 */

const node = (over: Partial<PlanNode> = {}): PlanNode => ({
  id: 'n2',
  description: '前端页面开发与联调',
  status: 'pending',
  dependsOn: [],
  ...over,
})

const spawn = (over: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
  type: 'tool_use',
  id: 'tu_1',
  name: 'spawn_agent',
  input: { task: 'do the frontend', planNode: 'n2' },
  ...over,
})

const messagesWith = (...blocks: ToolUseBlock[]): AgentMessage[] => [
  { id: 'a1', role: 'assistant', contentBlocks: blocks, createdAt: '2026-09-16T10:00:00.000Z' },
]

describe('resolvePlanNodeTarget', () => {
  it('opens the node-linked session and marks it live while the node is open', () => {
    const target = resolvePlanNodeTarget(node({ subConvId: 'sub_abc' }), [])
    expect(target).toEqual({ kind: 'session', subConvId: 'sub_abc', live: true })
  })

  it('stops polling once the node is settled', () => {
    for (const status of ['completed', 'failed', 'skipped'] as const) {
      expect(resolvePlanNodeTarget(node({ status, subConvId: 'sub_abc' }), []))
        .toEqual({ kind: 'session', subConvId: 'sub_abc', live: false })
    }
  })

  it('falls back to the spawn block when the plan node has no link yet', () => {
    // The window between dispatch and the plan round-trip (the plan mirror
    // updates a beat after the block's status diff).
    const messages = messagesWith(spawn({ subConvId: 'sub_live', planNodeId: 'n2' }))
    expect(resolvePlanNodeTarget(node(), messages))
      .toEqual({ kind: 'session', subConvId: 'sub_live', live: true })
  })

  it('recognises a spawn that only carries the call parameter (n2 / 2 alike)', () => {
    for (const planNode of ['n2', 2]) {
      const messages = messagesWith(spawn({ input: { task: 'x', planNode }, subConvId: 'sub_param' }))
      expect(resolvePlanNodeTarget(node(), messages)).toMatchObject({ subConvId: 'sub_param' })
    }
  })

  it('prefers the newest dispatch of a re-dispatched node', () => {
    const messages = messagesWith(
      spawn({ id: 'tu_old', input: { task: 'x', planNode: 'n2' }, subConvId: 'sub_old' }),
      spawn({ id: 'tu_new', input: { task: 'x', planNode: 'n2' }, subConvId: 'sub_new' }),
    )
    expect(resolvePlanNodeTarget(node(), messages)).toMatchObject({ subConvId: 'sub_new' })
  })

  it('ignores spawns of other nodes and non-spawn tools', () => {
    const messages = messagesWith(
      spawn({ id: 'tu_other', input: { task: 'x', planNode: 'n3' }, subConvId: 'sub_other' }),
      { type: 'tool_use', id: 'tu_read', name: 'read', input: {}, subConvId: 'sub_read' },
      // tagged but never got a session (the dispatch failed before spawning)
      spawn({ id: 'tu_bare', input: { task: 'x', planNode: 'n2' } }),
    )
    expect(resolvePlanNodeTarget(node({ msgId: 'msg_2' }), messages))
      .toEqual({ kind: 'message', msgId: 'msg_2' })
  })

  it('jumps the transcript when the main agent ran the node itself', () => {
    expect(resolvePlanNodeTarget(node({ status: 'completed', msgId: 'msg_9' }), []))
      .toEqual({ kind: 'message', msgId: 'msg_9' })
  })

  it('returns nothing for a node that was never dispatched and never settled', () => {
    expect(resolvePlanNodeTarget(node(), [])).toBeNull()
    expect(resolvePlanNodeTarget(undefined, [])).toBeNull()
  })
})
