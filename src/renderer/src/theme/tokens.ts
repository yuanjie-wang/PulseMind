import type { CSSProperties } from 'react'
import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import { INK, LINK, SURFACE, type ThemeMode } from './palette'

// ── Design tokens ──
// The app's visual language in one module: brand ink, the neutral ladder, the
// type/radius scales and the antd theme both algorithms build from. Components
// import these instead of repeating hex literals, so the palette cannot drift
// apart between surfaces. The color constants themselves live in palette.ts —
// the pure module the CSS variable sheet and the main process also read — and
// are re-exported here so existing import sites keep working. Values a probe
// pins stay byte-identical here: SURFACE_SUNK is the user bubble the extension
// panel mirrors by hand, and INK is the welcome send circle asserted at
// rgb(0,0,0).

export {
  INK,
  INK_HOVER,
  LINK,
  TEXT,
  TEXT_SECONDARY,
  TEXT_MUTED,
  TEXT_FAINT,
  BORDER,
  BORDER_HAIRLINE,
  SURFACE,
  SURFACE_SUNK,
  type ThemeMode,
  type ThemePreference,
} from './palette'

// ── Type scale ──
export const FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', Roboto, 'Helvetica Neue', 'Microsoft YaHei', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'"
export const FONT_SIZE = { sm: 12, base: 14, lg: 15, xl: 16 } as const
/** CJK never gets 700: PingFang has no bold cut and synthesizes one that goes
 *  fuzzy at small sizes — semibold is the heaviest weight in the app. */
export const FONT_WEIGHT = { regular: 400, medium: 500, semibold: 600 } as const

// Radius ladder: controls 8, cards 10–12, sheets 16, pills round.
export const RADIUS = { sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const

/** Numeric text (durations, token counts, ratios) aligns digit columns. */
export const TABULAR_NUMS: CSSProperties = { fontVariantNumeric: 'tabular-nums' }

/**
 * The ConfigProvider theme. Brand ink is the antd primary, which is what
 * replaces the app-wide `.ant-btn-primary` !important paint AppLayout used to
 * carry — antd's own hover and disabled states stay reachable, which the blunt
 * override used to erase. Dark mode flips the algorithm and inverts the solid
 * fill to light ink: black buttons vanish on a dark ground, light ones read.
 * The `mode` argument is the RESOLVED mode (see resolveThemePreference) — the
 * `system` preference never reaches here.
 */
export function buildAntdTheme(mode: ThemeMode): ThemeConfig {
  const dark = mode === 'dark'
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      fontFamily: FONT_FAMILY,
      colorPrimary: dark ? '#e6e6e6' : INK,
      colorLink: LINK,
      colorInfo: LINK,
      // Label on solid primary surfaces: white on ink (light), ink on light (dark).
      colorTextLightSolid: dark ? INK : '#ffffff',
      borderRadius: RADIUS.md,
      borderRadiusSM: RADIUS.sm,
      borderRadiusLG: RADIUS.lg,
      fontSize: FONT_SIZE.base,
      fontSizeSM: FONT_SIZE.sm,
      fontSizeLG: FONT_SIZE.lg,
      colorBgLayout: dark ? undefined : SURFACE,
      // Focus must read like hover: the ink primary derives controlOutline
      // rgba(0,0,0,0.75), which Input/Select/DatePicker/Radio draw as a 2px
      // halo — a border visually tripled in weight. Transparent leaves the
      // border-colour change as the only focus signal.
      controlOutline: 'transparent',
      // The root of the #404040 family the component fixes below keep working
      // around: controlItemBgActive derives from colorPrimaryBg, and under the
      // ink primary the "tint" is a DARK grey — while every consumer paints
      // dark ink on it in light mode. The visible breakage was the Dropdown's
      // own selected row (its sheet reads this alias directly, so no Menu
      // component token reaches it): the 项目 sort popup's current mode, the
      // composer's 授权 and the Table filter dropdown rendered black on
      // #404040, hovering the row black on #333. The same alias is the default
      // behind Menu's itemSelectedBg/itemActiveBg, Tree's nodeSelectedBg,
      // Transfer's selected rows, Calendar's itemActiveBg and Steps' finish
      // icon fill — one neutral pair heals all of them. The two values are the
      // pair Select's optionSelectedBg fix picked; hover is one step past the
      // selected grey per mode (light #ebebeb = --pm-fill-hover's literal).
      controlItemBgActive: dark ? '#333333' : '#f5f5f5',
      controlItemBgActiveHover: dark ? '#404040' : '#ebebeb',
    },
    components: {
      Select: {
        // The ink primary derives controlItemBgActive #404040, so the selected
        // dropdown option is dark grey under dark text. Neutral greys per mode:
        // the classic antd item grey in light, a step above the dark hover fill.
        optionSelectedBg: dark ? '#333333' : '#f5f5f5',
      },
      // The Table's selected row paints controlItemBgActive — the same derived
      // #404040 the Select fix above avoids, but across a WHOLE row: selecting
      // knowledge rows drew a charcoal stripe under dark text (light), and
      // dark mode's #535353 glows against the #141414 ground. The app's own
      // selected-row wash (--pm-hover-strong) per mode; hover one step past
      // it, above the plain rowHoverBg ladder.
      Table: {
        rowSelectedBg: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)',
        rowSelectedHoverBg: dark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.12)',
      },
      // A checked Checkbox is the primary with a colorWhite tick, and in dark
      // the primary is the near-white #e6e6e6 — the tick vanished (white on
      // white). Scoped colorWhite flips just the tick (the only colorWhite use
      // in the checkbox sheet) to ink, the same inversion solid primary
      // surfaces already take via colorTextLightSolid.
      Checkbox: dark ? { colorWhite: INK } : {},
      // Radio's checked dot is the same mechanism's second consumer: the dot
      // paints colorWhite on a colorPrimary disc — in dark, white on
      // near-white, the tick-vanished shape again (the MCP 传输类型 radios
      // were unreadable). The radio sheet's colorWhite use is the dot alone,
      // so the same scoped flip applies (review0924 M8).
      Radio: dark ? { colorWhite: INK } : {},
      // Destructive buttons are neutral, not red: every shade a danger Button
      // draws (text, solid fill, border, hover/active) derives from this one
      // seed under the active algorithm. Grey in light; in dark the seed is the
      // light-ink #e6e6e6 the dark theme already uses for its primary, so a
      // danger button reads white (with ink text on the solid confirm) there.
      // Scoped to Button, so error text, validation states and status reds
      // elsewhere keep colorError. The `danger` prop and the
      // .ant-btn-dangerous class stay — only the paint changes.
      Button: {
        colorError: dark ? '#e6e6e6' : '#8c8c8c',
      },
      // A checked Switch is green (antd's green ramp; light base is the same
      // green-6 as --pm-success-status, dark takes its green-5 counterpart).
      // Scoped to the switch: the ink primary everywhere else is untouched.
      Switch: dark
        ? { colorPrimary: '#73d13d', colorPrimaryHover: '#95de64', colorPrimaryActive: '#52c41a' }
        : { colorPrimary: '#52c41a', colorPrimaryHover: '#73d13d', colorPrimaryActive: '#389e0d' },
      // Tooltip text rides colorTextLightSolid, which dark mode flips to ink
      // for solid primary buttons — black on the dark tooltip ground. The
      // tooltip keeps its own light text in both modes (240,240,240 in dark).
      Tooltip: {
        colorTextLightSolid: dark ? 'rgb(240, 240, 240)' : '#ffffff',
      },
    },
  }
}
