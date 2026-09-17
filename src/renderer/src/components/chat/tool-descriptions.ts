/**
 * Module-level name → description registry for the tool-display fallback chain
 * (PLAN-tool-ux T1): unknown tools (MCP / user tools) resolve their human label
 * from the schema description's first sentence. The engine's tool collector
 * feeds it on every request (the same final toolset that ships as schemas),
 * mcp-cache style; `toolBlockSummary` only does pure lookups, so it stays
 * importable from tests and the extension mirror without any engine wiring.
 */

const descriptions = new Map<string, string>()

/** Feed (and overwrite) the registry from one toolset snapshot. */
export function registerToolDescriptions(defs: Array<{ name: string; description?: string }>): void {
  for (const def of defs) {
    if (def?.name && typeof def.description === 'string' && def.description.trim()) {
      descriptions.set(def.name, def.description)
    }
  }
}

/** Pure lookup — undefined when nothing was registered for the name. */
export function lookupToolDescription(name: string): string | undefined {
  return descriptions.get(name)
}

/** Test / isolate reset. */
export function resetToolDescriptions(): void {
  descriptions.clear()
}
