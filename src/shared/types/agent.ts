export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  status?: 'pending' | 'approved' | 'running' | 'completed' | 'rejected'
  output?: string
  exitCode?: number | null
  /** spawn_agent only: the sub-conversation this call hosts. Written by the
   *  engine that owns the handle (the main process), so a client learns it from
   *  the tool_status diff — the messages snapshot ships when the assistant
   *  message is created, i.e. before the spawn has a sub-conversation. */
  subConvId?: string
  /** spawn_agent only: the plan node this call implements (spawn_agent planNode=). */
  planNodeId?: string
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  imageData?: string
  /** Pointer to tool_results table (UUID); set when content is stored separately. */
  tool_result_id?: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
