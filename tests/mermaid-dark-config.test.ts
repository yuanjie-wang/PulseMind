/**
 * Source scans for the mermaid theme wiring (vitest here is node-env; the
 * renderer cannot mount — the measured colors live in
 * `node scripts/probe-mermaid-dark.mjs`). Non-vacuity: every asserted literal
 * is one whose removal is exactly the silent breakage it guards — dropping the
 * config prop reverts to the package's own `theme: 'default'` initialize (the
 * white-on-light report), dropping the 'dark' entry keeps the prop but never
 * switches, and dropping useThemeMode freezes whichever mode mounted first.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

describe('mermaid dark-theme wiring', () => {
  const codeBlock = read('src/renderer/src/components/chat/CodeBlock.tsx')

  it('CodeBlock picks the mermaid theme from the live mode, like Prism above it', () => {
    expect(codeBlock).toContain('useThemeMode()')
    expect(codeBlock).toContain('config={MERMAID_CONFIG[mode]}')
  })

  it('both modes have an explicit theme — dark switches, light stays the default', () => {
    expect(codeBlock).toContain("dark: { theme: 'dark' }")
    expect(codeBlock).toContain("light: { theme: 'default' }")
  })
})
