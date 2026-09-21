// ── Design palette (PLAN-dark-mode M1) ──
// The color constants AND the CSS custom-property sheet both modes are built
// from. This module is deliberately pure — no DOM, no antd — because three
// consumers import it: the renderer (the variable sheet), the main process
// (window background + title-bar overlay resolve the same preference), and the
// node-env vitest suite. The antd-theme half lives in tokens.ts, which imports
// antd and therefore cannot be shared upward.
//
// The LIGHT values are the pre-dark-mode app, byte for byte: tokens.ts's old
// "probe pins stay byte-identical" contract (SURFACE_SUNK is the extension
// panel's mirrored user bubble, INK is the welcome send circle asserted at
// rgb(0,0,0)) now holds by construction — those constants live here and
// tokens.ts re-exports them. Dark values are the second set; tint/danger
// families keep their hue and lift one antd-dark step for contrast on #141414.
//
// The mode-resolution rule itself lives in src/shared/theme.ts (the main
// process resolves the same preference for the window background and the
// title-bar overlay); it is re-exported here so renderer import sites have one
// theme module to read from.
import {
  resolveThemePreference,
  type ThemeMode,
  type ThemePreference,
} from '../../../shared/theme'

// Re-exported so renderer import sites have one theme module to read from.
export { resolveThemePreference, type ThemeMode, type ThemePreference }

/** Brand ink — the primary everywhere: buttons, switches, active states.
 *  Pure black on purpose; it is the look the app already wears. */
export const INK = '#000000'
/** Ink's hover shade, for class-scoped CSS rules that must match the hover
 *  family the token-driven primary sits in. */
export const INK_HOVER = '#333333'
/** The one blue that survives the ink takeover: links and info accents. antd
 *  derives colorLink from colorPrimary, so without this pin links would turn
 *  black and lose their affordance. */
export const LINK = '#1677ff'

// Neutral ladder, light theme.
export const TEXT = '#262626'
export const TEXT_SECONDARY = '#666666'
export const TEXT_MUTED = '#999999'
export const TEXT_FAINT = '#bbbbbb'
export const BORDER = '#d9d9d9'
export const BORDER_HAIRLINE = '#f0f0f0'
/** App shell + sidebar ground. Was a #f5f5f5 (antd layout default) under the
 *  content and a #F8F8F8 sider — one surface now. */
export const SURFACE = '#f7f7f8'
export const SURFACE_SUNK = '#f0f2f4'

/**
 * The CSS custom properties. Light is the current app; dark is its counterpart.
 * Role notes that survive the mode flip:
 *  - `--pm-sunk` (user bubble / pressed well) is *darker* than the ground in
 *    light and *lighter* in dark — same "recessed one step" reading, inverted.
 *  - `--pm-hover`/`--pm-veil*` are alpha overlays, so dark flips the ink from
 *    black to white; black alphas would be invisible on a dark ground.
 *  - `--pm-ink` inverts to light so solid ink surfaces stay visible, and
 *    `--pm-ink-contrast` is the text painted on them.
 *
 * The message layer (PLAN-dark-mode M2/T2) surfaced rungs the shell never used:
 * the chat body carries five borders, four soft inks and three fills, several of
 * them 1–8 units apart. Light is byte-identical by contract, so each literal
 * keeps a role name of its own instead of being folded onto a variable whose
 * light value differs — the dark column is where near-duplicates may collapse,
 * since a 4-unit grey difference carries no meaning on a dark ground. Families
 * keep their *ordering* across the flip: `--pm-text-faint` is the dimmest ink in
 * both modes (darkest in light, darkest in dark), and the border family runs
 * soft → frame → border → strong, faintest to strongest in both.
 */
export const PALETTE: { light: Record<string, string>; dark: Record<string, string> } = {
  light: {
    '--pm-bg': '#ffffff',
    '--pm-elevated': '#ffffff',
    '--pm-surface': SURFACE,
    '--pm-sunk': SURFACE_SUNK,
    '--pm-ink': INK,
    '--pm-ink-hover': INK_HOVER,
    '--pm-ink-contrast': '#ffffff',
    '--pm-text': TEXT,
    '--pm-text-strong': '#333333',
    '--pm-text-secondary': TEXT_SECONDARY,
    '--pm-text-muted': TEXT_MUTED,
    '--pm-text-faint': TEXT_FAINT,
    '--pm-text-disabled': '#cccccc',
    '--pm-border': BORDER,
    '--pm-border-hairline': BORDER_HAIRLINE,
    // Message-layer roles (M2/T2) — light = the literal each replaced.
    '--pm-fill': '#f5f5f5',
    '--pm-fill-hover': '#ebebeb',
    /** A recessed text panel (the thinking block's expanded pre). */
    '--pm-fill-soft': '#f6f6f6',
    '--pm-text-body': '#555555',
    '--pm-text-quiet': '#888888',
    '--pm-text-soft': '#aaaaaa',
    '--pm-separator': '#dddddd',
    /** The pane dividers in the browser/workbench chrome (#ececf0) — a cool
     *  grey a step LIGHTER than --pm-separator in light, and correspondingly
     *  fainter than it in dark. */
    '--pm-separator-faint': '#ececf0',
    '--pm-border-soft': '#e8e8e8',
    '--pm-border-strong': '#d0d0d0',
    /** A frame around embedded content (chat images). */
    '--pm-frame': '#e0e0e0',
    /** Machine output on a cool grey (the tool_result box). */
    '--pm-well': '#f6f8fa',
    '--pm-hover': 'rgba(0, 0, 0, 0.06)',
    '--pm-veil': 'rgba(0, 5, 10, 0.06)',
    '--pm-veil-strong': 'rgba(0, 5, 10, 0.08)',
    '--pm-link': LINK,
    /** A link-tinted wash over the chat ground (the jump-to-message highlight). */
    '--pm-link-bg': 'rgba(22, 119, 255, 0.08)',
    '--pm-warn': '#d46b08',
    /** The amber held-approval surface and its hover (antd's gold-1/2/3). */
    '--pm-warn-bg': '#fff7e6',
    '--pm-warn-bg-hover': '#ffe7ba',
    '--pm-warn-border': '#ffd591',
    '--pm-error': '#cf1322',
    '--pm-success': '#389e0d',
    // Input-layer roles (M2/T3) — light = the literal each replaced.
    /** The composer card's frosted fill. The opaque one is `--pm-elevated`:
     *  Windows drops the blur, so the same card is painted flat there. */
    '--pm-elevated-glass': 'rgba(255, 255, 255, 0.85)',
    /** A hairline *over* an elevated surface (composer card, @-popup, KB tag).
     *  Distinct from `--pm-veil-strong` by 5 units of blue, and that difference
     *  is why it is not folded onto it: the light theme is frozen. */
    '--pm-border-veil': 'rgba(0, 0, 0, 0.08)',
    '--pm-border-veil-weak': 'rgba(0, 0, 0, 0.06)',
    /** The @-popup's highlighted row — a step fainter than `--pm-hover`. */
    '--pm-hover-weak': 'rgba(0, 0, 0, 0.05)',
    /** Floating surfaces need their own shadows in dark: a black shadow at the
     *  light alpha is invisible on a dark ground, so the dark column deepens it. */
    '--pm-shadow-pop': '0 6px 24px rgba(0, 0, 0, 0.12)',
    '--pm-shadow-glass': '0 5px 20px 2px rgb(80 100 200 / 20%)',
    /** The composer's chips: the bound expert on its own line, the picked
     *  files/folders on the slightly stronger one. */
    '--pm-pill': '#f0f0f0',
    '--pm-pill-strong': '#e8e8e8',
    /** The file/web chip's paper: a white card tinted by the extension's hue.
     *  The hue stays in the component (it is data); the white end and the two
     *  lightness knobs ride the sheet, so the same chip reads as a dark card. */
    '--pm-chip-from': '#ffffff',
    '--pm-chip-from-hover': '#fafafa',
    '--pm-chip-tint-l': '95%',
    '--pm-chip-tint-l-hover': '92%',
    '--pm-chip-border': '#e6e6e6',
    '--pm-chip-letter-l': '85%',
    '--pm-chip-letter-a': '0.5',
    /** A rung between `--pm-text-secondary` and `--pm-text-quiet` (the
     *  deliverable row's kind glyph). */
    '--pm-text-dim': '#777777',
    /** The deliverables card (M2/T3): a soft grey card inside the transcript. */
    '--pm-tile-bg': '#fafbfc',
    '--pm-tile-border': '#eceef2',
    /** The card's internal hairline and its badge fill — one literal in the
     *  source, so one role here. */
    '--pm-tile-soft': '#f0f1f4',
    '--pm-tile-hover': '#f5f6f8',
    /** A card's one-line row text — the deliverables row and, since M3/T0, the
     *  sidebar's conversation/project rows, which carried the same `#444`. */
    '--pm-row-ink': '#444444',
    /** The deliverable row's 预览 affordance — a second blue that only ever
     *  appeared there (`--pm-link` is the app's link token). */
    '--pm-link-preview': '#1a73e8',
    /** The Word/Excel badge: a green tag, not the antd success colour. */
    '--pm-tag-success-bg': '#e8f0e8',
    '--pm-tag-success-ink': '#2e7d32',
    // ChatView-surroundings roles (M2/T4) — light = the literal each replaced.
    /** The plan strip's outline: a cool grey a hair off `--pm-chip-border`, so
     *  it keeps its own role (the light theme is frozen). */
    '--pm-pop-border': '#e5e6eb',
    /** A small floating surface's shadow (`--pm-shadow-pop` is the large one). */
    '--pm-shadow-soft': '0 2px 8px rgba(0, 0, 0, 0.08)',
    /** The retry banner: its accent is #ff9500 — not antd's gold — so the wash,
     *  the ring and the ink are three alpha/shade rungs of that one hue. */
    '--pm-retry-bg': 'rgba(255, 149, 0, 0.08)',
    '--pm-retry-border': 'rgba(255, 149, 0, 0.25)',
    '--pm-retry-ink': '#b84d00',
    /** The loop-limit prompt's own amber family (antd's gold ramp): the light
     *  values are a rung or two off `--pm-warn`'s, so they are their own roles.
     *  Dark takes the same rung of antd's dark gold ramp, which is why they do
     *  NOT collapse onto the warn family's dark values. */
    '--pm-gold-bg': '#fffbe6',
    '--pm-gold-border': '#ffe58f',
    '--pm-gold-ink': '#ad6f00',
    '--pm-gold-solid': '#d48806',
    /** The error box (antd's red ramp, light: bg = red-1, border = red-2). */
    '--pm-error-bg': '#fff2f0',
    '--pm-error-border': '#ffccc7',
    /** The starter-prompt pill's outline — one unit off `--pm-chip-border` in
     *  light, hence its own role. */
    '--pm-prompt-pill-border': '#e5e5e7',
    /** The faintest hover wash (the context ring's disc) — half of `--pm-hover`. */
    '--pm-hover-faint': 'rgba(0, 0, 0, 0.03)',
    /** The welcome page's logo is a pure-black PNG, so dark inverts it: `filter`
     *  is a mode-dependent presentation value like any other. `none` in light is
     *  a no-op, so it neither paints nor creates a containing block. */
    '--pm-logo-filter': 'none',
    /** The code card's wash (M2/T5): `CodeHighlight`'s standalone background and
     *  `PlainCode`'s — the same literal before the migration, hence one role.
     *  Both columns mirror `@ant-design/x-markdown`'s OWN code background
     *  (`--light-bg` / `--dark-bg` in its theme sheets), which is what paints the
     *  inner `<code>` inside the chat's markdown — so a standalone caller (skill
     *  preview, text preview) shows the same wash the chat's blocks do. Prism's
     *  token colours cannot be a variable (they are a JS object), so the card is
     *  the half of a code block the sheet can carry; the tokens ride
     *  CodeHighlight's own subscription. */
    '--pm-code-bg': 'rgba(0, 0, 0, 0.04)',
    '--pm-sidebar': 'linear-gradient(180deg, #f5f7fa 0%, #f0f0f0 100%)',
    '--pm-scrollbar': '#d0d0d0',
    '--pm-scrollbar-active': '#b0b0b0',
    // Shell-interior roles (M3/T0) — the literals inside surfaces the shell
    // migration had already darkened: the sidebar's rows, the ⌘K palette, search,
    // the project modal, the error boundary and the editor layout. Light is again
    // byte-identical, so each literal keeps a role of its own rather than being
    // folded onto a variable whose light value differs.
    /** A panel title's ink — the ⌘K row label and a search hit's title, a rung
     *  above `--pm-text-strong`. */
    '--pm-text-title': '#222222',
    /** The faintest *readable* ink: a count badge, a muted marker. Below it only
     *  `--pm-text-disabled` (decorative) remains. */
    '--pm-text-ghost': '#c8c8c8',
    /** An ink that is an alpha, not a grey — antd's own `colorTextTertiary`, the
     *  nav caret. Alpha because it must sit on the sidebar's gradient. */
    '--pm-text-tertiary': 'rgba(0, 0, 0, 0.45)',
    /** The *selected* row's wash — a step stronger than `--pm-hover`. Distinct
     *  from `--pm-veil-strong` by 5 units of blue, and that difference is why it
     *  is not folded onto it: the light theme is frozen. */
    '--pm-hover-strong': 'rgba(0, 0, 0, 0.08)',
    /** The pressed/active pane row (pane-styles) — one step past strong. */
    '--pm-hover-stronger': 'rgba(0, 0, 0, 0.09)',
    /** A wash so faint it reads as a change of paper, not as a highlight (the
     *  applied-patch bar). */
    '--pm-fill-ghost': 'rgba(0, 0, 0, 0.02)',
    /** The faintest separator — a list row's underline, below `--pm-border-hairline`. */
    '--pm-border-faint': '#f5f5f5',
    /** A list row's hover ground (search hits) — a rung off `--pm-fill`. */
    '--pm-row-hover': '#f7f7f7',
    /** An opaque card *inside* a `--pm-fill` surface (the editor layout's chat
     *  card). Distinct from `--pm-elevated`/`--pm-fill`: both of those darken to
     *  `#1f1f1f`, which would make the card vanish against the editor's ground. */
    '--pm-card': '#ffffff',
    /** antd's gold-6: a *status* dot and marker (retrying, unsaved, favourite) —
     *  not the held-approval amber, which has its own warn family. */
    '--pm-gold-accent': '#faad14',
    /** antd's red-5 as a *status* colour (a field's error text, an inline
     *  failure) — a step brighter than `--pm-error`'s red-7. */
    '--pm-error-status': '#ff4d4f',
    /** antd green-6 as a status colour — the pair of --pm-error-status. */
    '--pm-success-status': '#52c41a',
    /** The crash screen's own red, which is the CSS keyword `red` in the source
     *  (written as `#ff0000` to keep this table hex-uniform; it renders the
     *  same). Not `--pm-error`: on the boundary's `--pm-fill` ground the darker
     *  red measures 4.17:1, below AA. */
    '--pm-error-bright': '#ff0000',
    // Welcome-band roles (M3/T1) — light is again the literal each replaced.
    /** The welcome cards' paper (`CARD_BG`, both welcome components share it).
     *  `--pm-surface` is the same hex in light but is the SHELL ground, which
     *  darkens BELOW the content in dark; a card must sit above its ground, so
     *  it takes the elevated rung in the dark column instead. */
    '--pm-card-soft': '#f7f7f8',
    '--pm-card-soft-hover': '#efeff1',
    /** The dashed outline of the create/empty project card. Not `--pm-border`
     *  (#d9d9d9): the dash is four units cooler, and the light theme is frozen. */
    '--pm-dash-border': '#c8c8cc',
    /** The loading skeleton's bar — a cool grey, so the dark column keeps the
     *  same faint blue lean rather than collapsing onto plain `--pm-fill`. */
    '--pm-skeleton': '#e9e9ec',
    /** The capability card's footer divider (#f2f2f2): a hairline between
     *  --pm-border-hairline and --pm-border-faint, hence its own role. */
    '--pm-card-divider': '#f2f2f2',
    /** A recessed panel behind commands/instructions (MCP 的命令井, 工具说明).
     *  Not --pm-well (#f6f8fa, cool) nor --pm-tile-bg (#fafbfc): this grey is
     *  hue-neutral, which is why it keeps its own role. */
    '--pm-wash': '#fafafa',
    /** The command well's prompt glyph and its endpoint ink — a rung between
     *  ghost and disabled. */
    '--pm-wash-ink': '#c0c0c0',
    /** The skill browser's outer frame (#eee) — its own grey, one off soft. */
    '--pm-wash-border': '#eeeeee',
    /** The browser chrome's address bar / recent-list wash (#f7f8fa) — a cool
     *  step between --pm-wash and --pm-tile-bg, hence its own role. */
    '--pm-wash-cool': '#f7f8fa',
    /** The browser tab's resting elevation and the address dropdown's shadow —
     *  two more members of the shadow family, each byte-preserved from the
     *  chrome that carried them. */
    '--pm-shadow-chip': '0 1px 2px rgba(0, 0, 0, 0.08)',
    '--pm-shadow-dropdown': '0 8px 24px rgba(0, 0, 0, 0.12)',
    /** The success banner (测试连接's outcome box): antd green-1 bg, green-3
     *  border — the light values are the literals the settings page carried. */
    '--pm-success-bg': '#f6ffed',
    '--pm-success-border': '#b7eb8f',
    /** The muted card's detail ink — a rung between `--pm-text-soft` and
     *  `--pm-text-faint` in both columns (#aaa < #b3b3b3 < #bbb in light, the
     *  reverse in dark), hence its own role rather than a fold onto faint. */
    '--pm-text-haze': '#b3b3b3',
    // Plan-graph roles (M3/T2) — the DAG's private ink ladder. Light is again
    // the literal each replaced; several are exact matches of shell roles
    // (#262626 = --pm-text, #c8c8c8 = --pm-text-ghost, #d9d9d9 = --pm-border,
    // #e0e0e0 = --pm-frame, #f0f0f0 = --pm-border-hairline, #f5f5f5 =
    // --pm-fill) and reuse them rather than re-role-ing the same hex.
    /** The card's primary reading ink (编号/任务内容/展开 toggle/复位 label). */
    '--pm-graph-ink': '#595959',
    /** Settled words, the in-flight card's border, the blocked glyph. */
    '--pm-graph-ink-dim': '#8c8c8c',
    /** The hollow glyphs (pending circle, skipped minus). */
    '--pm-graph-ink-faint': '#bfbfbf',
    /** The node in flight — the darkest ink in the graph, and the only card
     *  whose words are at full weight. */
    '--pm-graph-ink-live': '#141414',
    /** Blocked words: readable, visibly out of play. */
    '--pm-graph-ink-blocked': '#737373',
    /** Skipped words and the unassigned assignee: the hollowest readable ink. */
    '--pm-graph-ink-hollow': '#a6a6a6',
    /** The skipped card's border — one step fainter than --pm-border-soft. */
    '--pm-graph-border-skip': '#ececec',
    /** The pan canvas behind the cards — a hair off --pm-fill so the white
     *  cards read as cards. */
    '--pm-graph-canvas': '#fafafa',
    '--pm-graph-shadow': '0 1px 4px rgba(0, 0, 0, 0.12)',
    // Preview-layer roles (M4/T1–T3) — light is again the literal each replaced.
    /** The desk behind the PDF page boxes. The docx/pptx counterparts keep the
     *  docx-preview/shared `#808080` literal instead: a mid-grey reads as
     *  neutral on both grounds, and docx-preview paints the wrapper half of
     *  that surface itself (see DocxPreview's BACKDROP note). */
    '--pm-desk': '#e9eaee',
    /** The paper's edge shadow — deepens in dark, where a light-theme shadow
     *  alpha disappears against the desk and the white page loses its edge. */
    '--pm-shadow-page': '0 1px 4px rgba(0, 0, 0, 0.18)',
    /** The active toggle/tab fill: antd's blue-1 as an OPAQUE fill (the
     *  preview's source toggle, the xlsx sheet tab). Not `--pm-link-bg` — that
     *  is an alpha wash over the chat ground; this one sits on chrome. */
    '--pm-link-bg-solid': '#e6f4ff',
    /** The xlsx grid's default ink — the color the cells used to INHERIT from
     *  antd's App wrapper (colorText), now written explicitly so a workbook
     *  without per-cell fonts stays readable when the ground flips. */
    '--pm-sheet-ink': 'rgba(0, 0, 0, 0.88)',
    /** The PDF page-jump input's border — #e0e0e6, six units of blue off
     *  `--pm-frame`, hence its own role (the light theme is frozen). */
    '--pm-input-border': '#e0e0e6',
    /** A solid disabled button fill (the element panel's AI run button) — the
     *  enabled state is `--pm-link`, the ink on both is `--pm-ink-contrast`. */
    '--pm-btn-disabled': '#d9d9d9',
    /** The danger action's wash behind its icon (the element panel's delete) —
     *  one step stronger than `--pm-hover-faint`, hence its own role. */
    '--pm-danger-wash': 'rgba(0, 0, 0, 0.04)',
    /** The workbench tab strip's muted count badge — a solid cool-grey fill
     *  carrying white ink (the plan badge takes `--pm-link` instead). */
    '--pm-badge-muted': '#b9bdc7',
  },
  dark: {
    '--pm-bg': '#141414',
    '--pm-elevated': '#1f1f1f',
    '--pm-surface': '#0f0f0f',
    '--pm-sunk': '#262626',
    '--pm-ink': '#e6e6e6',
    '--pm-ink-hover': '#f5f5f5',
    '--pm-ink-contrast': '#000000',
    '--pm-text': '#e6e6e6',
    '--pm-text-strong': '#ececec',
    '--pm-text-secondary': '#a6a6a6',
    '--pm-text-muted': '#8c8c8c',
    '--pm-text-faint': '#595959',
    '--pm-text-disabled': '#4d4d4d',
    '--pm-border': '#424242',
    '--pm-border-hairline': '#2b2b2b',
    '--pm-fill': '#1f1f1f',
    '--pm-fill-hover': '#262626',
    '--pm-fill-soft': '#101010',
    '--pm-text-body': '#c2c2c2',
    '--pm-text-quiet': '#999999',
    '--pm-text-soft': '#737373',
    '--pm-separator': '#424242',
    '--pm-separator-faint': '#2c2c2c',
    '--pm-border-soft': '#333333',
    '--pm-border-strong': '#4d4d4d',
    '--pm-frame': '#3d3d3d',
    '--pm-well': '#0f0f0f',
    '--pm-hover': 'rgba(255, 255, 255, 0.08)',
    '--pm-veil': 'rgba(255, 255, 255, 0.08)',
    '--pm-veil-strong': 'rgba(255, 255, 255, 0.12)',
    '--pm-link': '#4096ff',
    '--pm-link-bg': 'rgba(64, 150, 255, 0.16)',
    '--pm-warn': '#d89614',
    '--pm-warn-bg': '#2b2111',
    '--pm-warn-bg-hover': '#443111',
    '--pm-warn-border': '#7c5914',
    '--pm-error': '#ff7875',
    '--pm-success': '#49aa19',
    '--pm-elevated-glass': 'rgba(31, 31, 31, 0.85)',
    '--pm-border-veil': 'rgba(255, 255, 255, 0.14)',
    '--pm-border-veil-weak': 'rgba(255, 255, 255, 0.10)',
    '--pm-hover-weak': 'rgba(255, 255, 255, 0.07)',
    '--pm-shadow-pop': '0 6px 24px rgba(0, 0, 0, 0.6)',
    '--pm-shadow-glass': '0 5px 20px 2px rgba(0, 0, 0, 0.55)',
    '--pm-pill': '#262626',
    '--pm-pill-strong': '#333333',
    '--pm-chip-from': '#1f1f1f',
    '--pm-chip-from-hover': '#262626',
    '--pm-chip-tint-l': '16%',
    '--pm-chip-tint-l-hover': '20%',
    '--pm-chip-border': '#3d3d3d',
    '--pm-chip-letter-l': '42%',
    '--pm-chip-letter-a': '0.35',
    '--pm-text-dim': '#a0a0a0',
    '--pm-tile-bg': '#1a1a1a',
    '--pm-tile-border': '#2c2c2c',
    '--pm-tile-soft': '#2f2f2f',
    '--pm-tile-hover': '#232323',
    '--pm-row-ink': '#c8c8c8',
    '--pm-link-preview': '#6aa9f8',
    '--pm-tag-success-bg': '#16281a',
    '--pm-tag-success-ink': '#5fbf6a',
    '--pm-pop-border': '#424242',
    '--pm-shadow-soft': '0 2px 8px rgba(0, 0, 0, 0.5)',
    '--pm-retry-bg': 'rgba(255, 149, 0, 0.16)',
    '--pm-retry-border': 'rgba(255, 149, 0, 0.35)',
    '--pm-retry-ink': '#ffb454',
    '--pm-gold-bg': '#2b2111',
    '--pm-gold-border': '#594214',
    '--pm-gold-ink': '#f3cc62',
    '--pm-gold-solid': '#e8b339',
    '--pm-error-bg': '#2a1215',
    '--pm-error-border': '#431418',
    '--pm-prompt-pill-border': '#424242',
    '--pm-hover-faint': 'rgba(255, 255, 255, 0.05)',
    '--pm-logo-filter': 'invert(1)',
    '--pm-code-bg': 'rgba(255, 255, 255, 0.1)',
    // Lifted 2026-09-20 (user: 深色侧边栏要浅一些) — the sider now reads as a
    // distinct, slightly elevated surface instead of melting into the #141414
    // content ground. Top stays the lighter end (same shape as light).
    '--pm-sidebar': 'linear-gradient(180deg, #26262a 0%, #1c1c1e 100%)',
    '--pm-scrollbar': '#3a3a3a',
    '--pm-scrollbar-active': '#4a4a4a',
    '--pm-text-title': '#f0f0f0',
    '--pm-text-ghost': '#4f4f4f',
    '--pm-text-tertiary': 'rgba(255, 255, 255, 0.45)',
    '--pm-hover-strong': 'rgba(255, 255, 255, 0.12)',
    '--pm-hover-stronger': 'rgba(255, 255, 255, 0.14)',
    '--pm-fill-ghost': 'rgba(255, 255, 255, 0.03)',
    '--pm-border-faint': '#262626',
    '--pm-row-hover': '#1f1f1f',
    '--pm-card': '#262626',
    '--pm-gold-accent': '#d89614',
    '--pm-error-status': '#ff7875',
    '--pm-success-status': '#73d13d',
    '--pm-error-bright': '#ff7875',
    '--pm-card-soft': '#1f1f1f',
    '--pm-card-soft-hover': '#262626',
    '--pm-dash-border': '#4d4d4d',
    '--pm-skeleton': '#2e2e30',
    '--pm-card-divider': '#2c2c2c',
    '--pm-wash': '#1a1a1a',
    '--pm-wash-ink': '#5c5c5c',
    '--pm-wash-border': '#2d2d2d',
    '--pm-wash-cool': '#202022',
    '--pm-shadow-chip': '0 1px 2px rgba(0, 0, 0, 0.6)',
    '--pm-shadow-dropdown': '0 8px 24px rgba(0, 0, 0, 0.6)',
    '--pm-success-bg': '#12211a',
    '--pm-success-border': '#2f5a2f',
    '--pm-text-haze': '#6e6e6e',
    '--pm-graph-ink': '#c9c9c9',
    '--pm-graph-ink-dim': '#909090',
    '--pm-graph-ink-faint': '#5f5f5f',
    '--pm-graph-ink-live': '#f0f0f0',
    '--pm-graph-ink-blocked': '#8f8f8f',
    '--pm-graph-ink-hollow': '#6e6e6e',
    '--pm-graph-border-skip': '#303030',
    '--pm-graph-canvas': '#191919',
    '--pm-graph-shadow': '0 1px 4px rgba(0, 0, 0, 0.5)',
    '--pm-desk': '#1f1f22',
    '--pm-shadow-page': '0 1px 4px rgba(0, 0, 0, 0.6)',
    '--pm-link-bg-solid': '#111a2c',
    '--pm-sheet-ink': 'rgba(255, 255, 255, 0.85)',
    '--pm-input-border': '#424242',
    '--pm-btn-disabled': '#4d4d4d',
    '--pm-danger-wash': 'rgba(255, 255, 255, 0.06)',
    '--pm-badge-muted': '#595959',
  },
}

/**
 * The stylesheet `installThemeVars()` injects. `:root` carries light;
 * `[data-theme='dark']` (same element, so equal specificity — order is the
 * cascade) overrides it. Every variable appears in both blocks; the test
 * suite fails if the sets ever drift.
 */
export function buildThemeCss(): string {
  const block = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([name, value]) => `  ${name}: ${value};`)
      .join('\n')
  return `:root {\n${block(PALETTE.light)}\n}\n\n[data-theme='dark'] {\n${block(PALETTE.dark)}\n}\n`
}
