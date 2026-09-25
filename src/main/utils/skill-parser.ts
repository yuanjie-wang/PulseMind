/**
 * SKILL.md parsing/formatting for the Agent Skills format (agentskills.io),
 * the same SKILL.md layout used by Claude Code and OpenClaw.
 *
 * YAML is handled by a dependency-free subset engine (`parseYamlLite`) that
 * covers the constructs that actually appear in ecosystem skill frontmatter:
 * nested maps, block sequences, flow sequences/maps, quoted scalars,
 * `|`/`>` block scalars with chomping, plain-scalar folding, and comments.
 * Constructs outside the subset are skipped leniently instead of failing the
 * whole file; required-field violations (no name, no body) still throw.
 */

import type { SkillDefinition } from '../../shared/types/skill-types'
import { sha256Hex } from '../../shared/memory/content-hash'

// ---------------------------------------------------------------------------
// YAML subset engine
// ---------------------------------------------------------------------------

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue }

function stripComment(s: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") {
        if (s[i + 1] === "'") i++
        else quote = null
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s.trimEnd()
}

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}

/** Index of the next line carrying content, or -1 when exhausted. */
function nextContentLine(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t !== '' && !t.startsWith('#')) return i
  }
  return -1
}

function isSeqItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

/** Position of the `:` that terminates a mapping key, or -1. */
function findKeyColon(content: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ' || content[i + 1] === '\t')) {
      return i
    }
  }
  return -1
}

function unescapeScalar(t: string): string {
  const trimmed = t.trim()
  if (trimmed.startsWith('"')) {
    let out = ''
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === '\\' && i + 1 < trimmed.length) {
        const esc = trimmed[++i]
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc
        continue
      }
      if (ch === '"') break
      out += ch
    }
    return out
  }
  if (trimmed.startsWith("'")) {
    let out = ''
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === "'") {
        if (trimmed[i + 1] === "'") {
          out += "'"
          i++
        } else break
      } else out += trimmed[i]
    }
    return out
  }
  return trimmed
}

function matchBlockScalarMarker(rest: string): string | null {
  return /^(?:[|>][+-]?)$/.test(rest) ? rest : null
}

/** Read a `|`/`>` block scalar body. `cursor.i` must already sit past the header line. */
function readBlockScalar(lines: string[], cursor: { i: number }, keyIndent: number, marker: string): string {
  const literal = marker[0] === '|'
  const chomp = marker.length > 1 ? marker[1] : ''
  let contentIndent = -1
  const collected: string[] = []
  let i = cursor.i
  while (i < lines.length) {
    const raw = lines[i]
    if (raw.trim() === '') {
      collected.push('')
      i++
      continue
    }
    const ind = indentOf(raw)
    if (contentIndent === -1) {
      if (ind <= keyIndent) break
      contentIndent = ind
    }
    if (ind < contentIndent) break
    collected.push(raw.slice(contentIndent))
    i++
  }
  cursor.i = i

  let end = collected.length
  while (end > 0 && collected[end - 1] === '') end--
  const trailingBlanks = collected.length - end
  const body = collected.slice(0, end)

  let text: string
  if (literal) {
    text = body.join('\n')
  } else {
    const parts: string[] = []
    let buf: string[] = []
    for (const line of body) {
      if (line === '') {
        parts.push(buf.join(' '))
        buf = []
      } else buf.push(line)
    }
    if (buf.length) parts.push(buf.join(' '))
    text = parts.join('\n')
  }
  if (chomp === '-') return text
  if (chomp === '+') return text + '\n' + '\n'.repeat(trailingBlanks)
  return text ? text + '\n' : text // clip
}

// --- Flow collections (`[a, b]`, `{k: v}`), possibly spanning lines ---

function flowDepth(s: string): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
  }
  return depth
}

function parseFlow(s: string, pos: number, keyContext = false): { value: YamlValue; end: number } {
  while (pos < s.length && /\s/.test(s[pos])) pos++
  if (s[pos] === '[') {
    const items: YamlValue[] = []
    pos++
    for (;;) {
      while (pos < s.length && /\s/.test(s[pos])) pos++
      if (pos >= s.length) return { value: items, end: pos }
      // Accept both closing brackets in either collection — lenient recovery from mismatches
      if (s[pos] === ']' || s[pos] === '}') return { value: items, end: pos + 1 }
      const item = parseFlow(s, pos)
      items.push(item.value)
      pos = item.end
      while (pos < s.length && /\s/.test(s[pos])) pos++
      if (s[pos] === ',') pos++
    }
  }
  if (s[pos] === '{') {
    const map: Record<string, YamlValue> = {}
    pos++
    for (;;) {
      while (pos < s.length && /\s/.test(s[pos])) pos++
      if (pos >= s.length) return { value: map, end: pos }
      if (s[pos] === '}' || s[pos] === ']') return { value: map, end: pos + 1 }
      const key = parseFlow(s, pos, true)
      pos = key.end
      while (pos < s.length && /\s/.test(s[pos])) pos++
      let value: YamlValue = ''
      if (s[pos] === ':') {
        const v = parseFlow(s, pos + 1)
        value = v.value
        pos = v.end
      }
      map[String(typeof key.value === 'string' ? key.value : JSON.stringify(key.value))] = value
      while (pos < s.length && /\s/.test(s[pos])) pos++
      if (s[pos] === ',') pos++
    }
  }
  // Scalar token: up to the next `,`/`]`/`}` (and `:` for map keys), quote-aware.
  // end must always advance past pos, or a stray closing bracket would loop forever.
  let quote: '"' | "'" | null = null
  let end = pos
  while (end < s.length) {
    const ch = s[end]
    if (quote === '"') {
      if (ch === '\\') end++
      else if (ch === '"') quote = null
    } else if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === ',' || ch === ']' || ch === '}') break
    else if (keyContext && ch === ':') break
    end++
  }
  return { value: unescapeScalar(s.slice(pos, end)), end: end === pos ? pos + 1 : end }
}

/** Read a flow collection that may continue on following lines until brackets balance. */
function readFlow(lines: string[], cursor: { i: number }, firstChunk: string): YamlValue {
  let text = firstChunk
  while (flowDepth(text) > 0 && cursor.i < lines.length) {
    text += ' ' + stripComment(lines[cursor.i++]).trim()
  }
  return parseFlow(text, 0).value
}

// --- Block map / sequence ---

function parseBlock(lines: string[], cursor: { i: number }): YamlValue {
  const i = nextContentLine(lines, cursor.i)
  if (i === -1) {
    cursor.i = lines.length
    return ''
  }
  const content = stripComment(lines[i]).trim()
  cursor.i = i
  return isSeqItem(content) ? parseSeq(lines, cursor, indentOf(lines[i])) : parseMap(lines, cursor, indentOf(lines[i]))
}

function parseMap(lines: string[], cursor: { i: number }, indent: number): Record<string, YamlValue> {
  const result: Record<string, YamlValue> = {}
  while (cursor.i < lines.length) {
    const i = nextContentLine(lines, cursor.i)
    if (i === -1) {
      cursor.i = lines.length
      break
    }
    const raw = lines[i]
    const ind = indentOf(raw)
    if (ind < indent) break
    if (ind > indent) {
      cursor.i = i + 1 // stray deeper line (malformed or exotic YAML) — skip, don't fail the file
      continue
    }
    const content = stripComment(raw).trim()
    if (isSeqItem(content)) break // sequence at the same level belongs to the caller
    cursor.i = i + 1

    const keyEnd = findKeyColon(content)
    if (keyEnd === -1) continue // not a key line — skip leniently
    const key = unescapeScalar(content.slice(0, keyEnd))
    const rest = content.slice(keyEnd + 1).trim()

    if (rest === '') {
      const j = nextContentLine(lines, cursor.i)
      result[key] = j !== -1 && indentOf(lines[j]) > ind ? parseBlock(lines, cursor) : ''
      continue
    }

    const blockMarker = matchBlockScalarMarker(rest)
    if (blockMarker) {
      result[key] = readBlockScalar(lines, cursor, ind, blockMarker)
      continue
    }
    if (rest[0] === '[' || rest[0] === '{') {
      result[key] = readFlow(lines, cursor, rest)
      continue
    }

    if (rest.startsWith('"') || rest.startsWith("'")) {
      result[key] = unescapeScalar(rest)
      continue
    }
    // Plain scalar: fold following deeper non-key lines (multi-line plain style)
    let text = rest
    for (;;) {
      const j = nextContentLine(lines, cursor.i)
      if (j === -1) break
      const deeper = stripComment(lines[j]).trim()
      if (indentOf(lines[j]) <= ind || isSeqItem(deeper) || findKeyColon(deeper) !== -1) break
      text += ' ' + deeper
      cursor.i = j + 1
    }
    result[key] = text
  }
  return result
}

function parseSeq(lines: string[], cursor: { i: number }, indent: number): YamlValue[] {
  const items: YamlValue[] = []
  while (cursor.i < lines.length) {
    const i = nextContentLine(lines, cursor.i)
    if (i === -1) {
      cursor.i = lines.length
      break
    }
    const raw = lines[i]
    const ind = indentOf(raw)
    if (ind < indent) break
    if (ind > indent) {
      cursor.i = i + 1
      continue
    }
    const content = stripComment(raw).trim()
    if (!isSeqItem(content)) break
    const rest = content === '-' ? '' : content.slice(2).trim()
    cursor.i = i + 1

    if (rest === '') {
      const j = nextContentLine(lines, cursor.i)
      items.push(j !== -1 && indentOf(lines[j]) > ind ? parseBlock(lines, cursor) : '')
      continue
    }
    const blockMarker = matchBlockScalarMarker(rest)
    if (blockMarker) {
      items.push(readBlockScalar(lines, cursor, ind, blockMarker))
      continue
    }
    if (rest[0] === '[' || rest[0] === '{') {
      items.push(readFlow(lines, cursor, rest))
      continue
    }
    // `- key: value` — parse as a nested map by rewriting the item line to key indent
    if (findKeyColon(rest) !== -1) {
      const virtualIndent = ind + 2
      const patched = lines.slice()
      patched[i] = ' '.repeat(virtualIndent) + rest
      const sub = { i }
      items.push(parseMap(patched, sub, virtualIndent))
      cursor.i = sub.i
      continue
    }
    items.push(unescapeScalar(rest))
  }
  return items
}

/** Parse a frontmatter chunk (text between the `---` delimiters) into a plain object. */
function parseYamlLite(text: string): Record<string, YamlValue> {
  const cursor = { i: 0 }
  const value = parseBlock(text.split('\n'), cursor)
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

// ---------------------------------------------------------------------------
// SKILL.md document model
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  name: string
  description: string
  category: string
  triggers: string[]
  systemPrompt: string
  sourceConversationId?: string
  createdAt?: string
  /** Agent Skills spec optional fields — preserved instead of dropped. */
  license?: string
  compatibility?: string
  metadata?: Record<string, YamlValue>
  allowedTools?: string
  /** Unknown frontmatter fields, preserved verbatim (e.g. OpenClaw's `user-invocable`). */
  extra?: Record<string, YamlValue>
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'category',
  'triggers',
  'sourceConversationId',
  'createdAt',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
])

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

function isMap(v: unknown): v is Record<string, YamlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseSkillMarkdown(content: string, fileName: string): ParsedFrontmatter {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new Error(`${fileName}: SKILL.md must start with "---" frontmatter delimiter`)
  }

  let endIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i
      break
    }
  }
  if (endIndex === -1) {
    throw new Error(`${fileName}: Missing closing "---" frontmatter delimiter`)
  }

  const fm = parseYamlLite(lines.slice(1, endIndex).join('\n'))
  const systemPrompt = lines
    .slice(endIndex + 1)
    .join('\n')
    .trim()
  if (!systemPrompt) {
    throw new Error(`${fileName}: System prompt body is empty (text after closing "---")`)
  }

  const name = str(fm.name)
  if (!name) {
    throw new Error(`${fileName}: Missing required "name" field in frontmatter`)
  }

  const extra: Record<string, YamlValue> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(k)) extra[k] = v
  }

  return {
    name,
    description: str(fm.description) || name,
    category: str(fm.category) || 'imported',
    triggers: strList(fm.triggers),
    systemPrompt,
    sourceConversationId: str(fm.sourceConversationId) || undefined,
    createdAt: str(fm.createdAt) || undefined,
    license: str(fm.license) || undefined,
    compatibility: str(fm.compatibility) || undefined,
    metadata: isMap(fm.metadata) ? fm.metadata : undefined,
    allowedTools: str(fm['allowed-tools']) || undefined,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  }
}

// ---------------------------------------------------------------------------
// Agent Skills spec validation (advisory warnings, never hard failures)
// ---------------------------------------------------------------------------

const SPEC_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function validateSkillSpec(parsed: Pick<ParsedFrontmatter, 'name' | 'description' | 'compatibility'>, dirName?: string): string[] {
  const warnings: string[] = []
  if (parsed.name.length > 64) {
    warnings.push(`name exceeds the 64-character spec limit (${parsed.name.length})`)
  } else if (!SPEC_NAME_RE.test(parsed.name)) {
    warnings.push(`name "${parsed.name}" doesn't match the Agent Skills spec (lowercase letters, digits, single hyphens)`)
  }
  if (dirName && dirName !== parsed.name) {
    warnings.push(`directory "${dirName}" doesn't match the skill name "${parsed.name}"`)
  }
  if (parsed.description.length > 1024) {
    warnings.push(`description exceeds the 1024-character spec limit (${parsed.description.length})`)
  }
  if (parsed.compatibility && parsed.compatibility.length > 500) {
    warnings.push(`compatibility exceeds the 500-character spec limit (${parsed.compatibility.length})`)
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Emitting SKILL.md (used by skill creation / built-in skill seeding)
// ---------------------------------------------------------------------------

/** Characters that are safe to leave unquoted in a YAML scalar. */
const PLAIN_SAFE_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .()/@+-]*$/
const YAML_AMBIGUOUS_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'])

function emitScalar(v: string): string {
  const plain = v !== '' && v === v.trim() && PLAIN_SAFE_RE.test(v) && !YAML_AMBIGUOUS_WORDS.has(v.toLowerCase())
  if (plain) return v
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
}

const PLAIN_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

function emitEntry(key: string, value: unknown, indent: string, out: string[]): void {
  const keyText = PLAIN_KEY_RE.test(key) ? key : emitScalar(key)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${indent}${keyText}: []`)
      return
    }
    out.push(`${indent}${keyText}:`)
    for (const item of value) {
      out.push(`${indent}  - ${typeof item === 'string' ? emitScalar(item) : JSON.stringify(item)}`)
    }
    return
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      out.push(`${indent}${keyText}: {}`)
      return
    }
    out.push(`${indent}${keyText}:`)
    for (const [k, v] of entries) emitEntry(k, v, indent + '  ', out)
    return
  }
  out.push(`${indent}${keyText}: ${emitScalar(String(value))}`)
}

/** Format a skill as a valid SKILL.md document with YAML frontmatter. */
export function formatSkillMd(skill: SkillDefinition): string {
  const lines: string[] = ['---']
  lines.push(`name: ${emitScalar(skill.name)}`)
  lines.push(`description: ${emitScalar(skill.description)}`)
  if (skill.category) lines.push(`category: ${emitScalar(skill.category)}`)
  if (skill.triggers?.length) {
    lines.push('triggers:')
    for (const t of skill.triggers) lines.push(`  - ${emitScalar(t)}`)
  }
  if (skill.license) lines.push(`license: ${emitScalar(skill.license)}`)
  if (skill.compatibility) lines.push(`compatibility: ${emitScalar(skill.compatibility)}`)
  if (skill.allowedTools) lines.push(`allowed-tools: ${emitScalar(skill.allowedTools)}`)
  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    emitEntry('metadata', skill.metadata, '', lines)
  }
  if (skill.sourceConversationId) lines.push(`sourceConversationId: ${emitScalar(skill.sourceConversationId)}`)
  if (skill.createdAt) lines.push(`createdAt: ${emitScalar(skill.createdAt)}`)
  lines.push('---', '', skill.systemPrompt)
  return lines.join('\n')
}

/** JSON with object keys sorted, so the digest never depends on property order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}

/**
 * Format-independent fingerprint of a skill's meaning-carrying fields.
 *
 * The retired-built-in sweep (skill-store.ensureBuiltInSkills) has to answer
 * "is this file the app's own seed, or did the user touch it?" across formatter
 * versions: the file on disk and the reference can be re-serialized by
 * DIFFERENT versions of `formatSkillMd` (the 2026-09-15 parser rewrite started
 * quoting descriptions — which is exactly why the old whole-file byte compare
 * stopped recognizing a seed written before it). So both sides are reduced to
 * parsed fields and hashed: the digest survives formatting drift and changes on
 * any real content edit.
 *
 * The field set is FIXED: widening it re-hashes every existing digest, and the
 * `RETIRED_BUILT_IN_SKILLS` contentHash values must be recomputed with it
 * (tests/retired-skill-sweep.test.ts pins them against the definitions as they
 * last shipped).
 */
export function skillContentSignature(skill: SkillDefinition | ParsedFrontmatter): string {
  return sha256Hex(
    stableStringify({
      name: skill.name,
      description: skill.description,
      category: skill.category ?? '',
      triggers: skill.triggers ?? [],
      systemPrompt: skill.systemPrompt,
      license: skill.license ?? null,
      compatibility: skill.compatibility ?? null,
      allowedTools: skill.allowedTools ?? null,
      metadata: skill.metadata ?? null,
      sourceConversationId: skill.sourceConversationId ?? null,
      createdAt: skill.createdAt ?? null,
      extra: skill.extra ?? null
    })
  )
}
