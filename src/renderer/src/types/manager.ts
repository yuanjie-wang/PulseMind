/**
 * Generic registry for feature managers (tools and skills).
 *
 * Both ToolManager and SkillManager share the same CRUD/toggle/preferences
 * pattern. This class extracts that shared behavior so neither manager
 * needs to duplicate it.
 */

export interface FeatureState<T> {
  definition: T
  enabled: boolean
}

export class FeatureRegistry<T extends { name: string }> {
  private items = new Map<string, FeatureState<T>>()

  /**
   * Register an array of built-in definitions.
   * @param defaultEnabled Optional set of names to enable by default.
   */
  registerBuiltIn(defs: T[], defaultEnabled?: Set<string>): void {
    for (const def of defs) {
      if (!this.items.has(def.name)) {
        const enabled = defaultEnabled?.has(def.name) ?? false
        this.items.set(def.name, { definition: def, enabled })
      }
    }
  }

  /** Apply an array of enabled names to all registered items. */
  applyPreferences(enabledNames: string[]): void {
    for (const [, state] of this.items) {
      state.enabled = enabledNames.includes(state.definition.name)
    }
  }

  /** Get the list of enabled names for persistence. */
  getPreferences(): string[] {
    return this.getEnabled().map((s) => s.definition.name)
  }

  // --- Queries ---

  getAll(): FeatureState<T>[] {
    return Array.from(this.items.values())
  }

  getEnabled(): FeatureState<T>[] {
    return this.getAll().filter((s) => s.enabled)
  }

  get(name: string): FeatureState<T> | undefined {
    return this.items.get(name)
  }

  // --- Mutations ---

  enable(name: string): boolean {
    const item = this.items.get(name)
    if (!item) return false
    item.enabled = true
    return true
  }

  disable(name: string): boolean {
    const item = this.items.get(name)
    if (!item) return false
    item.enabled = false
    return true
  }

  toggle(name: string): boolean | null {
    const item = this.items.get(name)
    if (!item) return null
    item.enabled = !item.enabled
    return item.enabled
  }

  register(def: T, autoEnable = false): boolean {
    if (this.items.has(def.name)) return false
    this.items.set(def.name, { definition: def, enabled: autoEnable })
    return true
  }

  unregister(name: string): boolean {
    return this.items.delete(name)
  }
}

/**
 * Base class for domain managers that wrap FeatureRegistry.
 *
 * Provides the common passthrough pattern so ToolManager and SkillManager
 * don't duplicate getAll/getEnabled/enable/disable/toggle/register/unregister.
 * Domain-specific logic (system prompt construction, LLM tool generation)
 * lives in the subclass.
 */
export abstract class FeatureManager<T extends { name: string; builtIn?: boolean }> {
  protected registry = new FeatureRegistry<T>()

  getAll(): FeatureState<T>[] {
    return this.registry.getAll()
  }

  getEnabled(): FeatureState<T>[] {
    return this.registry.getEnabled()
  }

  get(name: string): FeatureState<T> | undefined {
    return this.registry.get(name)
  }

  enable(name: string): boolean {
    return this.registry.enable(name)
  }

  disable(name: string): boolean {
    return this.registry.disable(name)
  }

  toggle(name: string): boolean | null {
    return this.registry.toggle(name)
  }

  register(def: T, autoEnable = false): boolean {
    return this.registry.register(def, autoEnable)
  }

  unregister(name: string): boolean {
    const item = this.registry.get(name)
    if (!item || item.definition.builtIn) return false
    return this.registry.unregister(name)
  }
}
