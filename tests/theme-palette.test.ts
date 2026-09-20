// PLAN-dark-mode M1 — the palette and the theme wiring.
// palette.ts is pure (no DOM, no antd: the main process imports it), so the
// variable sheet and the resolution rule are covered directly. Everything DOM
// or React-shaped is asserted as source scans, because vitest here is
// node-env: the hooks and App cannot be mounted (same reasoning as
// tests/pending-approval.test.ts). Non-vacuity is built in: the AppLayout scan
// fails if a literal hover/ink colour returns to the shell stylesheet, and the
// wiring scans fail if any hop of the resolve chain is dropped.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PALETTE, buildThemeCss, resolveThemePreference } from '../src/renderer/src/theme/palette'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('PALETTE', () => {
  it('light and dark define the exact same variable set', () => {
    expect(Object.keys(PALETTE.dark).sort()).toEqual(Object.keys(PALETTE.light).sort())
  })

  it('light values are the pre-dark-mode app, byte for byte', () => {
    // The probe pins live here: INK is the welcome send circle's rgb(0,0,0),
    // SURFACE_SUNK is the extension panel's mirrored user bubble, SURFACE the
    // shell ground. Changing any of these changes the light theme.
    expect(PALETTE.light['--pm-ink']).toBe('#000000')
    expect(PALETTE.light['--pm-sunk']).toBe('#f0f2f4')
    expect(PALETTE.light['--pm-surface']).toBe('#f7f7f8')
    expect(PALETTE.light['--pm-bg']).toBe('#ffffff')
    expect(PALETTE.light['--pm-link']).toBe('#1677ff')
    expect(PALETTE.light['--pm-text']).toBe('#262626')
    expect(PALETTE.light['--pm-hover']).toBe('rgba(0, 0, 0, 0.06)')
    expect(PALETTE.light['--pm-sidebar']).toBe('linear-gradient(180deg, #f5f7fa 0%, #f0f0f0 100%)')
    // The message layer's own literals (M2/T2), pinned for the same reason: each
    // is a value a migrated component used to carry inline, and the light theme
    // is not allowed to move.
    expect(PALETTE.light['--pm-fill']).toBe('#f5f5f5')
    expect(PALETTE.light['--pm-fill-hover']).toBe('#ebebeb')
    expect(PALETTE.light['--pm-well']).toBe('#f6f8fa')
    expect(PALETTE.light['--pm-border-soft']).toBe('#e8e8e8')
    expect(PALETTE.light['--pm-frame']).toBe('#e0e0e0')
    expect(PALETTE.light['--pm-text-body']).toBe('#555555')
    expect(PALETTE.light['--pm-warn-bg']).toBe('#fff7e6')
    expect(PALETTE.light['--pm-warn-border']).toBe('#ffd591')
    expect(PALETTE.light['--pm-link-bg']).toBe('rgba(22, 119, 255, 0.08)')
    // The code card's wash (M2/T5) — the value is x-markdown's own `--light-bg`,
    // which is what paints the inner `<code>` inside the chat's markdown (the §8
    // probe measures both), so the standalone card and the chat's block agree.
    expect(PALETTE.light['--pm-code-bg']).toBe('rgba(0, 0, 0, 0.04)')
    // The shell interior's own literals (M3/T0) — the same pin, for the same
    // reason: every one of these was carried inline by a component before the
    // migration, and a "tidier" value here would be a light-mode change.
    expect(PALETTE.light['--pm-text-title']).toBe('#222222')
    expect(PALETTE.light['--pm-text-ghost']).toBe('#c8c8c8')
    expect(PALETTE.light['--pm-text-tertiary']).toBe('rgba(0, 0, 0, 0.45)')
    expect(PALETTE.light['--pm-hover-strong']).toBe('rgba(0, 0, 0, 0.08)')
    expect(PALETTE.light['--pm-fill-ghost']).toBe('rgba(0, 0, 0, 0.02)')
    expect(PALETTE.light['--pm-border-faint']).toBe('#f5f5f5')
    expect(PALETTE.light['--pm-row-hover']).toBe('#f7f7f7')
    expect(PALETTE.light['--pm-card']).toBe('#ffffff')
    expect(PALETTE.light['--pm-gold-accent']).toBe('#faad14')
    expect(PALETTE.light['--pm-error-status']).toBe('#ff4d4f')
    expect(PALETTE.light['--pm-error-bright']).toBe('#ff0000')
    // The rename is part of the same contract: the role the deliverables row and
    // the sidebar rows now share is `--pm-row-ink`, and its light value is the
    // `#444444` both of them carried.
    expect(PALETTE.light['--pm-row-ink']).toBe('#444444')
    expect(PALETTE.light['--pm-tile-ink']).toBeUndefined()
    // The welcome band's own literals (M3/T1) — same pin, same reason: each was
    // carried inline by ProjectCards/WelcomeSuggestions before the migration.
    expect(PALETTE.light['--pm-card-soft']).toBe('#f7f7f8')
    expect(PALETTE.light['--pm-card-soft-hover']).toBe('#efeff1')
    expect(PALETTE.light['--pm-dash-border']).toBe('#c8c8cc')
    expect(PALETTE.light['--pm-skeleton']).toBe('#e9e9ec')
    expect(PALETTE.light['--pm-text-haze']).toBe('#b3b3b3')
    // The preview layer's own literals (M4/T1–T3) — same pin, same reason:
    // each was carried inline by a preview component before the migration.
    // --pm-sheet-ink deserves its note: its light value is the antd colorText
    // the xlsx grid used to INHERIT from the App wrapper, now written down.
    expect(PALETTE.light['--pm-desk']).toBe('#e9eaee')
    expect(PALETTE.light['--pm-shadow-page']).toBe('0 1px 4px rgba(0, 0, 0, 0.18)')
    expect(PALETTE.light['--pm-link-bg-solid']).toBe('#e6f4ff')
    expect(PALETTE.light['--pm-sheet-ink']).toBe('rgba(0, 0, 0, 0.88)')
    expect(PALETTE.light['--pm-input-border']).toBe('#e0e0e6')
    expect(PALETTE.light['--pm-btn-disabled']).toBe('#d9d9d9')
    expect(PALETTE.light['--pm-danger-wash']).toBe('rgba(0, 0, 0, 0.04)')
  })

  it('keeps the ink and border ladders ordered across the flip', () => {
    // Both families are read against opposite grounds, so each runs monotone in
    // both modes and *reverses* its direction: the ink ladder starts at the
    // strongest ink (darkest in light, brightest in dark) and the border ladder
    // at its faintest member (lightest in light, darkest in dark). That is what
    // makes a dark screen read as the same design rather than an inverted one —
    // and it is the assertion a careless new rung breaks.
    const lum = (hex: string): number => {
      const m = /^#([0-9a-f]{6})$/.exec(hex)
      if (!m) throw new Error(`not a hex colour: ${hex}`)
      const n = parseInt(m[1], 16)
      return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)
    }
    const direction = (xs: number[]): number => {
      const deltas = xs.slice(1).map((x, i) => x - xs[i])
      expect(deltas.every((d) => d !== 0)).toBe(true)
      const up = deltas.every((d) => d > 0)
      const down = deltas.every((d) => d < 0)
      expect(up || down).toBe(true)
      return up ? 1 : -1
    }
    const ladders = [
      // --pm-text-dim (M2/T3) sits between secondary and quiet in both columns:
      // #777777 between #666666 and #888888, #a0a0a0 between #a6a6a6 and #999999.
      // --pm-text-ghost (M3/T0) sits between faint and disabled — the last rung
      // that is still meant to be read: #c8c8c8 between #bbbbbb and #cccccc,
      // #4f4f4f between #595959 and #4d4d4d. --pm-text-haze (M3/T1) slots
      // between soft and faint: #b3b3b3 in light, #6e6e6e in dark.
      ['--pm-text-secondary', '--pm-text-dim', '--pm-text-quiet', '--pm-text-muted', '--pm-text-soft', '--pm-text-haze', '--pm-text-faint', '--pm-text-ghost', '--pm-text-disabled'],
      // --pm-border-faint (M3/T0) is the family's new faintest member: #f5f5f5
      // below #f0f0f0 in light, #262626 below #2b2b2b in dark.
      ['--pm-border-faint', '--pm-border-hairline', '--pm-border-soft', '--pm-frame', '--pm-border', '--pm-border-strong'],
    ]
    for (const ladder of ladders) {
      const light = direction(ladder.map((k) => lum(PALETTE.light[k])))
      const dark = direction(ladder.map((k) => lum(PALETTE.dark[k])))
      expect(dark).toBe(-light)
    }
  })

  it('dark flips the alpha overlays to white ink, not black', () => {
    // Black alphas are invisible on a dark ground — the whole point of the
    // hover/veil variables.
    expect(PALETTE.dark['--pm-hover']).toMatch(/^rgba\(255/)
    expect(PALETTE.dark['--pm-veil']).toMatch(/^rgba\(255/)
    expect(PALETTE.dark['--pm-veil-strong']).toMatch(/^rgba\(255/)
    // The three M3/T0 overlays too — the selected-row wash, the patch bar's
    // paper and the nav caret's ink are all black alphas in light, and a black
    // alpha on a dark ground is nothing at all.
    expect(PALETTE.dark['--pm-hover-strong']).toMatch(/^rgba\(255/)
    expect(PALETTE.dark['--pm-fill-ghost']).toMatch(/^rgba\(255/)
    expect(PALETTE.dark['--pm-text-tertiary']).toMatch(/^rgba\(255/)
    expect(PALETTE.dark['--pm-ink']).toBe('#e6e6e6')
    expect(PALETTE.dark['--pm-ink-contrast']).toBe('#000000')
    // The link wash is a *tint*, not a veil: dark lifts the link blue's alpha
    // instead of turning it white.
    expect(PALETTE.dark['--pm-link-bg']).toMatch(/^rgba\(64, 150, 255/)
  })
})

describe('buildThemeCss', () => {
  const css = buildThemeCss()

  it('declares light on :root first and dark on [data-theme] second (order is the cascade)', () => {
    const rootAt = css.indexOf(':root {')
    const darkAt = css.indexOf("[data-theme='dark'] {")
    expect(rootAt).toBeGreaterThanOrEqual(0)
    expect(darkAt).toBeGreaterThan(rootAt)
  })

  it('carries every variable in both blocks', () => {
    const namesIn = (section: string): string[] => [...section.matchAll(/(--pm-[a-z-]+):/g)].map((m) => m[1])
    const root = css.slice(css.indexOf(':root {'), css.indexOf("[data-theme='dark']"))
    const dark = css.slice(css.indexOf("[data-theme='dark']"))
    expect(namesIn(dark).sort()).toEqual(namesIn(root).sort())
    expect(namesIn(root).sort()).toEqual(Object.keys(PALETTE.light).sort())
  })

  it('emits the exact light values verbatim', () => {
    expect(css).toContain('--pm-ink: #000000;')
    expect(css).toContain('--pm-sunk: #f0f2f4;')
  })
})

describe('resolveThemePreference', () => {
  it('resolves the system preference against the OS answer', () => {
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
  })

  it('passes concrete modes through and treats unknown values as light', () => {
    expect(resolveThemePreference('dark', false)).toBe('dark')
    expect(resolveThemePreference('light', true)).toBe('light')
    expect(resolveThemePreference(undefined, true)).toBe('light')
    expect(resolveThemePreference('bogus', true)).toBe('light')
  })
})

describe('wiring (source scans — node-env cannot mount the App)', () => {
  it('dom.ts guards every DOM touch so vitest can import it', () => {
    const src = read('src/renderer/src/theme/dom.ts')
    expect(src).toContain("typeof document === 'undefined'")
    expect(src).toContain("typeof localStorage === 'undefined'")
  })

  it('main.tsx installs the variable sheet and applies the mirror before React mounts', () => {
    const src = read('src/renderer/src/main.tsx')
    expect(src).toContain('installThemeVars()')
    expect(src).toContain('applyThemePreference(bootThemePref')
    expect(src.indexOf('installThemeVars()')).toBeLessThan(src.indexOf('ReactDOM.createRoot'))
  })

  it('App.tsx resolves the preference, listens for OS flips and writes the mirror', () => {
    const src = read('src/renderer/src/App.tsx')
    expect(src).toContain("window.matchMedia('(prefers-color-scheme: dark)')")
    expect(src).toContain("mq.addEventListener('change', onChange)")
    expect(src).toContain('applyThemeAttr(resolvedTheme)')
    expect(src).toContain('writeThemeMirror(themePref)')
    expect(src).toContain('buildAntdTheme(resolvedTheme)')
  })

  it('the main process resolves system against nativeTheme on boot, save and OS flip', () => {
    const index = read('src/main/index.ts')
    expect(index).toContain('resolveThemePreference(')
    expect(index).toContain("nativeTheme.on('updated'")
    expect(index).toContain('WINDOW_BACKGROUND[bootThemeMode]')
    const handler = read('src/main/ipc/settings.handler.ts')
    expect(handler).toContain('resolveThemePreference(settings.theme, nativeTheme.shouldUseDarkColors)')
  })

  it('AppLayout consumes the variables and no longer carries literal shell colours', () => {
    const src = read('src/renderer/src/components/layout/AppLayout.tsx')
    // The migration's own pin: the shell stylesheet reads the sheet. If a
    // literal hover/ink/scroller colour returns here, dark mode silently
    // breaks while light still looks fine — exactly the drift this prevents.
    expect(src).not.toContain('rgba(0, 5, 10')
    expect(src).not.toContain('#d0d0d0')
    expect(src).toContain('var(--pm-veil)')
    expect(src).toContain('var(--pm-sidebar)')
    expect(src).toContain('var(--pm-scrollbar)')
  })
})
