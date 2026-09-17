// The committed picker bundle must equal a fresh regeneration
// (PLAN-html-element-edit §设计1 — same guard as the extension icons), and
// the payload must never contain a literal `</script` (it is inlined into a
// <script> element by serve-preview.ts; an early close would corrupt every
// injected page).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const GENERATED = join(ROOT, 'src/main/preview/picker-source.generated.ts')

describe('picker-source.generated.ts', () => {
  const before = readFileSync(GENERATED, 'utf8')

  it('regenerating the bundle does not change the committed file', () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts/build-preview-picker.mjs')], { cwd: ROOT })
    const after = readFileSync(GENERATED, 'utf8')
    expect(after).toBe(before)
  })

  it('the payload is a non-empty IIFE free of </script', () => {
    const match = /export const PICKER_SCRIPT = ("(?:[^"\\]|\\.)*")\n/.exec(before)
    expect(match).not.toBeNull()
    const code = JSON.parse(match![1]) as string
    expect(code.length).toBeGreaterThan(1000)
    expect(code.startsWith('(() =>')).toBe(true)
    expect(code).not.toMatch(/<\/script/i)
    // The picker must exclude its own nodes from pmPath counts (D4) and talk
    // to the parent over the pm: protocol only.
    expect(code).toContain('pm-picker-host')
    expect(code).toContain('pm:ready')
  })
})
