/**
 * Source scans for the HTML artifact card wiring (vitest here is node-env;
 * the renderer cannot mount). Non-vacuity: every asserted literal is one whose
 * removal is exactly the silent breakage it guards — dropping the sandbox
 * flags, moving the html dispatch behind the highlighter (or losing it), or
 * cutting the prompt section fails its own assertion.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('html artifact card wiring', () => {
  const codeBlock = read('src/renderer/src/components/chat/CodeBlock.tsx')
  const card = read('src/renderer/src/components/chat/HtmlArtifactCard.tsx')
  const prompt = read('src/renderer/src/agent/system-prompt-builder.ts')

  it('CodeBlock dispatches html fences to the card BEFORE the highlighter', () => {
    expect(codeBlock).toContain('isHtmlFenceLang(lang)')
    expect(codeBlock).toContain("streaming={streamStatus === 'loading'}")
    const cardBranch = codeBlock.indexOf('isHtmlFenceLang(lang)')
    const highlighter = codeBlock.indexOf('resolveCodeLang(lang)')
    expect(cardBranch).toBeGreaterThan(-1)
    expect(highlighter).toBeGreaterThan(-1)
    expect(cardBranch).toBeLessThan(highlighter)
  })

  it('the card iframe is sandboxed opaque-origin — never allow-same-origin', () => {
    expect(card).toContain('sandbox="allow-scripts allow-popups allow-forms allow-modals"')
    expect(card).not.toContain('allow-same-origin')
  })

  it('fragments get the height-reporting wrapper; full documents pass through', () => {
    expect(card).toContain('pm-html-card-height')
    expect(card).toContain('FULL_DOCUMENT')
  })

  it('the invariant core teaches the ```html card convention, after Render Reference', () => {
    expect(prompt).toContain('## Visual HTML Aids')
    const visual = prompt.indexOf('parts.push(HTML_VISUAL_AIDS)')
    const render = prompt.indexOf('parts.push(RENDER_REFERENCE)')
    expect(visual).toBeGreaterThan(-1)
    expect(visual).toBeGreaterThan(render)
  })
})
