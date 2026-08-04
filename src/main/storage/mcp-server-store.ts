import { join } from 'node:path'
import type { MCPClientConfig } from '../mcp/MCPClient'
import { DATA_DIR } from './index'
import { readJson, writeJson } from './json-store'

const MCP_SERVERS_PATH = join(DATA_DIR, 'mcp', 'mcp-servers.json')

export interface McpServerRecord {
  id: string
  config: MCPClientConfig
  autoStart?: boolean
  summary?: string
}

export class McpServerStore {
  async getAll(): Promise<McpServerRecord[]> {
    return readJson<McpServerRecord[]>(MCP_SERVERS_PATH, [])
  }

  async save(records: McpServerRecord[]): Promise<void> {
    await writeJson(MCP_SERVERS_PATH, records)
  }
}

export const mcpServerStore = new McpServerStore()
