import { OneShotAgent } from './OneShotAgent'

export interface MCPServerSummaryInput {
  serverName: string
  tools: Array<{ name: string; description: string }>
  locale?: string
}

export class MCPServerSummaryAgent extends OneShotAgent<MCPServerSummaryInput, string> {
  readonly name = 'MCPServerSummaryAgent'

  protected buildSystemPrompt(input: MCPServerSummaryInput): string {
    const isZh = input.locale === 'zh'
    if (isZh) {
      return '分析以下 MCP 服务器的工具列表，用 30-50 字概括该服务器提供的关键能力和使用场景。同时列出 3-5 个最重要的工具名称。格式："{概括} 工具：{工具名1}、{工具名2}..."。只返回一行结果，不要多余的解释。'
    }
    return 'Analyze the following MCP server\'s tool list. Summarize its key capabilities and use cases in 30-60 characters. Then list the 3-5 most important tool names. Format: "{summary} Tools: {tool1}, {tool2}...". Return one line only, no extra explanation.'
  }

  protected buildUserMessages(input: MCPServerSummaryInput): { role: string; content: string }[] {
    const toolList = input.tools
      .map(t => `- ${t.name}: ${t.description || '(no description)'}`)
      .join('\n')
    return [{ role: 'user', content: `Server: ${input.serverName}\n\nTools:\n${toolList}` }]
  }

  protected parseResponse(raw: string): string {
    return raw.trim().slice(0, 200)
  }

  protected getDefaultOutput(input: MCPServerSummaryInput): string {
    const names = input.tools.map(t => t.name)
    const toolNames = names.length <= 5 ? names.join(', ') : names.slice(0, 5).join(', ') + '...'
    return `${input.serverName} (${input.tools.length} tools): ${toolNames}`
  }
}
