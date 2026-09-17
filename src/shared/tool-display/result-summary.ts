/**
 * Result-side counting for the expanded tool card (PLAN-tool-ux T3, D3-B):
 * one summary line per tool family, parsed from the tool's own output.
 * Pure — no DOM, no antd, no i18n runtime — so the desktop CommandCard and
 * the extension panel's ToolCard share it verbatim (the wire strings are
 * hardcoded Chinese on both surfaces, like every panel label).
 *
 * `null` means "no confident parse" — the caller falls back to showing the
 * raw output as before, never inventing a count.
 */

export interface ToolResultSummary {
  line: string
}

/** Lines of the exec-result stdout section (between the --- stdout --- and
 *  --- stderr --- markers), minus blanks and the "(empty)" placeholder. */
function stdoutLines(output: string): string[] {
  const start = output.indexOf('--- stdout ---')
  if (start === -1) return []
  const bodyStart = start + '--- stdout ---'.length
  const end = output.indexOf('--- stderr ---', bodyStart)
  const body = end === -1 ? output.slice(bodyStart) : output.slice(bodyStart, end)
  return body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && l !== '(empty)')
}

export function resultSummary(name: string, output: string | undefined): ToolResultSummary | null {
  if (!output) return null
  switch (name) {
    case 'read': {
      // formatReadOutput's metadata: `  Size: 12.3 KB (1,204 lines)`
      const m = output.match(/\(([\d,]+) lines?\)/)
      if (!m) return null
      return { line: `${m[1]} 行` }
    }
    case 'search': {
      // ripgrep through formatExecResult: one stdout line ≈ one match
      const matches = stdoutLines(output).length
      if (matches === 0) return null
      return { line: `${matches.toLocaleString()} 处匹配` }
    }
    case 'list_dir':
    case 'find': {
      const entries = stdoutLines(output).length
      if (entries === 0) return null
      return { line: `${entries.toLocaleString()} 项` }
    }
    default:
      return null
  }
}
