/**
 * Environment-variable placeholder substitution for ${VAR} patterns.
 *
 * Two callers historically kept two copies of this logic with divergent
 * semantics — this module is the single implementation. The behavioral
 * difference is now an explicit option:
 *
 * - `keepMissing: true` (headers at request time): an unset variable leaves the
 *   placeholder intact so the caller can surface which variable is missing.
 * - `keepMissing: false` (settings at read time): an unset variable resolves to
 *   '' so a literal placeholder is never mistaken for a real value (e.g. an
 *   apiKey that would flip `hasApiKey` to true and be sent as-is).
 */

export function resolveEnvVarsInString(value: string, keepMissing = true): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const resolved = process.env[name]
    if (resolved !== undefined) return resolved
    return keepMissing ? match : ''
  })
}

/** Returns the variable name of the first ${VAR} placeholder still present in
 * `value`, or null when fully resolved. Request-time callers use this to fail
 * fast: sending an unresolved placeholder to a remote API would leak it as
 * broken credentials instead of surfacing which variable is missing. */
export function findUnresolvedEnvVar(value: string): string | null {
  const m = value.match(/\$\{([^}]+)\}/)
  return m ? m[1] : null
}

export interface ResolveEnvVarsDeepOptions {
  keepMissing?: boolean
  /** Object keys to leave untouched (e.g. profile `headers`, kept raw for request-time resolution). */
  skipKeys?: ReadonlySet<string>
}

export function resolveEnvVarsDeep(
  value: unknown,
  options: ResolveEnvVarsDeepOptions = {},
): unknown {
  const { keepMissing = true, skipKeys } = options
  if (typeof value === 'string') return resolveEnvVarsInString(value, keepMissing)
  if (Array.isArray(value)) return value.map((v) => resolveEnvVarsDeep(v, options))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (skipKeys?.has(k)) { result[k] = v; continue }
      result[k] = resolveEnvVarsDeep(v, options)
    }
    return result
  }
  return value
}