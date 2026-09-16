import type { ToolPreferences } from '../../../shared/types/tool-types'

export type { ToolPreferences }

// --- Tool Definition ---

export interface ToolInputSchema {
  type: 'object'
  properties: Record<
    string,
    {
      type: string
      description: string
      enum?: string[]
      /** Nested array element / object schemas — the wire schema is JSON Schema,
       *  so tool definitions may carry anything it allows (items, oneOf, …). */
      items?: Record<string, unknown>
      default?: unknown
      oneOf?: Array<Record<string, unknown>>
      [key: string]: unknown
    }
  >
  required?: string[]
  /** Root-level JSON Schema combinators (e.g. pick_skill's oneOf variants). */
  oneOf?: Array<Record<string, unknown>>
}

export interface ToolDefinition {
  name: string
  description: string
  category: string
  triggers?: string[]
  input_schema: ToolInputSchema
  instructions: string
  builtIn?: boolean
  /** Availability mode: 'always' (default) stays in the tool list; 'gated' is hidden until activated via pick_tool or keyword trigger. */
  availability?: 'always' | 'gated'
}

export interface ToolState {
  definition: ToolDefinition
  enabled: boolean
}

export interface ApiTool {
  name: string
  description: string
  input_schema: ToolInputSchema
}

/** @deprecated Renamed to ApiTool */
export type AnthropicTool = ApiTool
