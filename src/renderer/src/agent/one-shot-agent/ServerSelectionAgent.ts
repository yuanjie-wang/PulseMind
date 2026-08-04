import { OneShotAgent } from './OneShotAgent'

export interface ServerSelectionInput {
  intent: string
  serverList: string
}

/**
 * Selects the most relevant MCP server(s) based on user intent.
 * Operates at server level (not individual tool level) — the selected
 * server's tools are loaded in a subsequent step.
 */
export class ServerSelectionAgent extends OneShotAgent<ServerSelectionInput, string[]> {
  readonly name = 'ServerSelectionAgent'

  protected buildSystemPrompt(): string {
    return 'You are a server selection system. Given user intent and available MCP server summaries, select the most relevant server(s). Return ONLY comma-separated server names, no other text. If nothing matches, return "none".'
  }

  protected buildUserMessages(input: ServerSelectionInput): { role: string; content: string }[] {
    return [{
      role: 'user',
      content: `User intent: ${input.intent}\n\nAvailable MCP servers:\n${input.serverList}`
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
