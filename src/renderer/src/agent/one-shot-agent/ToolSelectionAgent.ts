import { OneShotAgent } from './OneShotAgent'

export interface ToolSelectionInput {
  intent: string
  toolsList: string
}

export class ToolSelectionAgent extends OneShotAgent<ToolSelectionInput, string[]> {
  readonly name = 'ToolSelectionAgent'

  protected buildSystemPrompt(): string {
    return 'You are a tool selection system. Given user intent and available MCP tools, select the most relevant tools. If none match, respond with "none". Return ONLY comma-separated tool names, no other text.'
  }

  protected buildUserMessages(input: ToolSelectionInput): { role: string; content: string }[] {
    return [{
      role: 'user',
      content: `User intent: ${input.intent}\n\nAvailable MCP tools:\n${input.toolsList}`
    }]
  }

  protected parseResponse(raw: string): string[] {
    const cleaned = raw.toLowerCase().trim()
    if (cleaned === 'none' || cleaned === '') return []
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }

  protected getDefaultOutput(): string[] {
    return []
  }
}
