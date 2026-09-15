/** The slice of the main agent session manager that the WS server and the
 *  hosted prompt router drive (PLAN-browser-extension M0). Declared as an
 *  interface so protocol tests can inject a fake without touching real
 *  settings, SQLite or LLM profiles — `agentSessionManager` satisfies it
 *  structurally. */
import type { AgentEventData, PageContext, ModelState } from '../../shared/agent-protocol'

export interface AgentServiceSessions {
  createSession(sessionId: string, opts: { agentId?: string; title?: string; clientId?: string }): Promise<{ sessionId: string; agentId: string }>
  ask(sessionId: string, content: string, pageContext?: PageContext): Promise<void>
  cancel(sessionId: string): void
  history(sessionId: string): Promise<{ messages: unknown[]; agentId: string }>
  hasSession(sessionId: string): boolean
  hydrate(sessionId: string, messages: unknown[], historySummary?: { text: string; firstKeptId: string } | null): Promise<void>
  engineCall(sessionId: string, method: string, args?: unknown[]): Promise<unknown>
  onEvent(sink: (sessionId: string, data: AgentEventData) => void): () => void
  /** model.list: the selectable LLM profiles + the active one (global). */
  modelState(): Promise<ModelState>
  /** model.setActive: switch the active profile (hot-swaps live sessions). */
  setActiveProfile(profileId: string): Promise<ModelState>
}
