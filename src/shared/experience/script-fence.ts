// Script-fence extraction (PLAN-experience-scripts 1.2): the extraction LLM
// declares companion scripts as fenced blocks inside the experience content:
//
//   ### File: scripts/名字.mjs
//   ```js
//   <script source>
//   ```
//
// Plain-text protocol stays (no JSON escaping of a 2000-token markdown body);
// this parser splits the fences out of the content. Pure + isomorphic so the
// vitest suite drives the exact function the agent's parseResponse calls.

export const MAX_SCRIPTS_PER_EXPERIENCE = 3

/** A script file that ships with an experience. `path` is relative to the
 *  experience dir and MUST start with `scripts/`. */
export interface ExperienceDraftFile {
  path: string
  content: string
}

export interface ScriptFenceResult {
  /** Content with the file fences stripped out. */
  content: string
  /** Accepted files (path already validated to start with scripts/). */
  files: ExperienceDraftFile[]
  /** Rejected paths with reasons — surfaced to logs/UI, never fatal. */
  rejected: Array<{ path: string; reason: string }>
}

/** A fence whose closing ``` never arrives means the LLM output was truncated
 *  mid-script: the whole file is discarded (the save-side `node --check` is
 *  the second line of defence). */
export function parseScriptFences(rawContent: string): ScriptFenceResult {
  const files: ExperienceDraftFile[] = []
  const rejected: Array<{ path: string; reason: string }> = []
  const lines = rawContent.split('\n')
  const kept: string[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^###\s+File:\s*(\S+)\s*$/)
    if (!m) {
      kept.push(line)
      i++
      continue
    }
    const path = m[1]
    // Find the opening fence on the next non-empty line
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const openLine = lines[j]?.trim() ?? ''
    if (!openLine.startsWith('```')) {
      rejected.push({ path, reason: 'file fence has no opening code block' })
      i = j // skip past whatever this was
      continue
    }
    // Scan for the closing fence
    let close = -1
    for (let k = j + 1; k < lines.length; k++) {
      if (lines[k].trim() === '```') { close = k; break }
    }
    if (close === -1) {
      rejected.push({ path, reason: 'unclosed code block (truncated output?) — file dropped' })
      break // nothing after a truncated fence is trustworthy
    }
    const content = lines.slice(j + 1, close).join('\n')
    if (!path.startsWith('scripts/')) {
      rejected.push({ path, reason: 'path must start with scripts/' })
    } else if (files.length >= MAX_SCRIPTS_PER_EXPERIENCE) {
      rejected.push({ path, reason: `more than ${MAX_SCRIPTS_PER_EXPERIENCE} files` })
    } else {
      files.push({ path, content })
    }
    i = close + 1
  }

  return { content: kept.join('\n'), files, rejected }
}

/** parseScriptFences 的对偶（PLAN-experience-sop B3）：把 files 数组还原成
 *  `### File:` 围栏文本——pick_skill 的经验信封消费（files_json 里存的脚本
 *  重新内联进正文形态，模型读到的就是提取协议的原始形状）。 */
export function serializeScriptFences(files: ReadonlyArray<{ path: string; content: string }>): string {
  return files
    .map((f) => `### File: ${f.path}\n\`\`\`js\n${f.content}\n\`\`\``)
    .join('\n\n')
}
