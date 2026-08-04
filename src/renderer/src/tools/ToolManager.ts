import type { ToolDefinition, ApiTool, ToolPreferences } from './types'
import { BUILT_IN_TOOLS } from './built-in-tools'
import { FeatureManager } from '../types/manager'

export class ToolManager extends FeatureManager<ToolDefinition> {
  private prefs: ToolPreferences = { enabledTools: [] }

  constructor() {
    super()
    this.registry.registerBuiltIn(BUILT_IN_TOOLS)
    this.applyPreferences()
  }

  // --- Domain alias methods ---

  getAllTools() { return this.getAll() }
  getEnabledTools() { return this.getEnabled() }
  getTool(name: string) { return this.get(name) }

  /** Register a user-installed tool with auto-enable. */
  registerTool(definition: ToolDefinition): boolean {
    return this.register(definition, true)
  }

  // --- Initialization ---

  applyPreferences(prefs?: ToolPreferences): void {
    if (prefs) this.prefs = prefs
    this.registry.applyPreferences(this.prefs.enabledTools)
  }

  getPreferences(): ToolPreferences {
    return { enabledTools: this.registry.getPreferences() }
  }

  // --- LLM Integration ---

  /** Build the tools array to send with every API request. */
  getTools(): ApiTool[] {
    return this.getEnabled().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      input_schema: t.definition.input_schema
    }))
  }

  getSystemPromptAppendix(): string {
    return ''
  }

  // --- Execution Routing ---

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.get(name)?.definition
  }
}
