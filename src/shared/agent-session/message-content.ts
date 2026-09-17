import type { AgentMessage } from '../../renderer/src/types/agent'

/** Runtime tool fields and message stats have their own diff channels. */
export function messageContentSignature(message: AgentMessage): string {
  return JSON.stringify([message.role, message.contentBlocks.map(block => {
    if (block.type !== 'tool_use') return block
    const content = { ...block } as Record<string, unknown>
    for (const runtime of ['status', 'exitCode', 'output', 'subConvId', 'planNodeId']) delete content[runtime]
    return content
  })])
}
