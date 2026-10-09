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

  it('fragments AND full documents get the height reporter; meta CSP is stripped off the served copy', () => {
    expect(card).toContain('pm-html-card-height')
    expect(card).toContain('FULL_DOCUMENT')
    expect(card).toContain('stripCspMeta')
    expect(card).toContain('injectBeforeBodyClose')
  })

  it('the chrome is hover-only and floats OUTSIDE the card (2026-10-09 ruling)', () => {
    // Hover state is JS-driven with a leave-grace (`.pm-html-card-on`), NOT a
    // CSS :hover gate — :hover flips pointer-events in the same frame hover
    // is lost, deadlocking a pointer that jumped past the toolbar's hit box.
    expect(card).toContain('pm-html-card-on')
    expect(card).toContain('CHROME_LEAVE_GRACE_MS')
    // No hover border (second ruling the same day): the root's border stays
    // transparent always — the flip machinery must not come back.
    expect(card).toContain("border: '1px solid transparent'")
    expect(card).not.toContain('--pm-card-border')
    // The toolbar sits at bottom:100% — entirely ABOVE the card. The root
    // must NOT clip it: the overflow:clip lives on .pm-html-card-body. This
    // is the shape that silently dies if someone re-adds overflow:hidden to
    // the root "for the corners".
    expect(card).toContain('bottom: 100%')
    expect(card).toContain('.pm-html-card-body { border-radius: 10px; overflow: hidden; }')
    expect(card).not.toMatch(/overflow: 'hidden',\s*\n\s*\}\}\s*\n\s*>/)
    // The flip (2026-10-09 occlusion report): when a clipping ancestor's top
    // edge leaves no headroom, the chrome moves INSIDE the card's top corners.
    expect(card).toContain('.pm-html-card-flip .pm-html-card-float { bottom: auto; top: 6px; }')
    expect(card).toContain('CHROME_FLIP_HEADROOM_PX')
  })

  it('the invariant core teaches the ```html card convention, after Render Reference', () => {
    expect(prompt).toContain('## Visual HTML Aids')
    const visual = prompt.indexOf('parts.push(HTML_VISUAL_AIDS)')
    const render = prompt.indexOf('parts.push(RENDER_REFERENCE)')
    expect(visual).toBeGreaterThan(-1)
    expect(visual).toBeGreaterThan(render)
  })
})
