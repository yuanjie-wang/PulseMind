import type { CSSProperties } from 'react'
import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'

// ── Design tokens ──
// The app's visual language in one module: brand ink, the neutral ladder, the
// type/radius scales and the antd theme both algorithms build from. Components
// import these instead of repeating hex literals, so the palette cannot drift
// apart between surfaces. Values a probe pins stay byte-identical here: SURFACE_SUNK
// is the user bubble the extension panel mirrors by hand, and INK is the welcome
// send circle asserted at rgb(0,0,0).

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

export type ThemeMode = 'light' | 'dark'

/**
 * The ConfigProvider theme. Brand ink is the antd primary, which is what
 * replaces the app-wide `.ant-btn-primary` !important paint AppLayout used to
 * carry — antd's own hover and disabled states stay reachable, which the blunt
 * override used to erase. Dark mode flips the algorithm and inverts the solid
 * fill to light ink: black buttons vanish on a dark ground, light ones read.
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
    },
    components: {
      Select: {
        // The ink primary derives controlItemBgActive #404040, so the selected
        // dropdown option is dark grey under dark text. Neutral greys per mode:
        // the classic antd item grey in light, a step above the dark hover fill.
        optionSelectedBg: dark ? '#333333' : '#f5f5f5',
      },
    },
  }
}
