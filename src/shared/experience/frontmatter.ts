// Experience SKILL.md frontmatter parsing (PLAN-experience-iteration).
// Hoisted out of ExperienceManager (it was module-private there) so the
// extraction-side dedup context — MemoryManager.buildExistingExperiencesText,
// which reads the LIVE pool in both hosts — can strip frontmatter off a
// record's SKILL.md with the exact same function the trigger rewrite uses.
// Pure + isomorphic: no fs, no DOM.

export interface ExperienceMdParts {
  title: string
  content: string
}

/** Split an experience's SKILL.md into its frontmatter title and the body.
 *  A file without a `---` fence reads as raw content with the fallback title. */
export function parseExperienceMd(raw: string, fallbackTitle: string): ExperienceMdParts {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return { title: fallbackTitle, content: raw }
  const fm = m[1]
  const content = m[2].trim()
  const titleMatch = fm.match(/^title:\s*(.*)$/m)
  let title = titleMatch ? titleMatch[1].trim() : fallbackTitle
  title = title.replace(/^["']|["']$/g, '')
  return { title, content }
}
