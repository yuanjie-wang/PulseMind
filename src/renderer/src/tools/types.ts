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
    }
  >
  required: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  category: string
  triggers?: string[]
  input_schema: ToolInputSchema
  instructions: string
  builtIn?: boolean
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
