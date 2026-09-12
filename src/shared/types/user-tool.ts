// ── User tool types (PLAN-0.4.0 M5.1) ──
// A user tool is a self-contained HTML app generated through dialog-driven
// creation (D6). Tools are for the USER to run (D11) — they are not registered
// as agent tools.

export type ToolCapability =
  | 'net:http'
  | 'fs:read'
  | 'fs:write'
  | 'clipboard'
  | 'notify'
  | 'open-external'

export interface UserTool {
  id: string
  name: string
  description: string
  icon?: string
  category?: string
  /** File name of the HTML entry inside the tool dir (default 'app.html'). */
  htmlPath: string
  /** Studio conversation for iterative modification. */
  conversationId?: string
  /** Capabilities the tool requests from the runtime bridge (M6). Declared at
   *  creation; enforced by the bridge host. */
  capabilities: ToolCapability[]
  /** Preset tool distributed with the app (M5R): a first-class tool the user
   *  can run, edit in place, duplicate and delete — same rights as any other. */
  preset?: boolean
  /** Bundle distribution id (preset tools only, used by restore re-seeding). */
  presetId?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ToolCreateInput {
  name: string
  description?: string
  category?: string
  capabilities?: ToolCapability[]
}

export interface ToolUpdateInput {
  name?: string
  description?: string
  category?: string
  htmlPath?: string
  conversationId?: string
  capabilities?: ToolCapability[]
}
