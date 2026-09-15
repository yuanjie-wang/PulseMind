// ── Tool visual identity (icon avatar + preset badge) ──
// One module so the list rows and the runner / workspace headers render a tool
// the same way. Presets are keyed by presetId — each shipped tool gets a
// hand-picked icon + tint. Anything else falls back to the name's first
// character on a tint derived from the id (stable across renders and renames),
// so 预置 tools read as a distinct kind at a glance, not just via the badge.

import React from 'react'
import { theme } from 'antd'
import {
  AppstoreOutlined,
  CalculatorOutlined,
  BgColorsOutlined,
  ApiOutlined,
  CodeOutlined,
  FileTextOutlined,
  ClockCircleOutlined,
  QrcodeOutlined,
} from '@ant-design/icons'
import type { UserTool } from '../../../../shared/types/user-tool'

type IconComponent = React.ComponentType<{ style?: React.CSSProperties }>

/** Foreground icon color on a translucent wash of the same hue — works on
 *  both the light and the dark container background. */
interface ToolTint {
  fg: string
  bg: string
}

const PRESET_LOOK: Record<string, { icon: IconComponent; tint: ToolTint }> = {
  calculator: { icon: CalculatorOutlined, tint: { fg: '#1677ff', bg: 'rgba(22,119,255,0.14)' } },
  'color-picker': { icon: BgColorsOutlined, tint: { fg: '#722ed1', bg: 'rgba(114,46,209,0.14)' } },
  'http-client': { icon: ApiOutlined, tint: { fg: '#08979c', bg: 'rgba(8,151,156,0.14)' } },
  'json-formatter': { icon: CodeOutlined, tint: { fg: '#389e0d', bg: 'rgba(56,158,13,0.14)' } },
  'md-note': { icon: FileTextOutlined, tint: { fg: '#d46b08', bg: 'rgba(212,107,8,0.14)' } },
  pomodoro: { icon: ClockCircleOutlined, tint: { fg: '#cf1322', bg: 'rgba(207,19,34,0.14)' } },
  qrcode: { icon: QrcodeOutlined, tint: { fg: '#2f54eb', bg: 'rgba(47,84,235,0.14)' } },
}

/** Pool the id-hash picks from for non-preset tools. */
const TINT_POOL: ToolTint[] = [
  { fg: '#1677ff', bg: 'rgba(22,119,255,0.14)' },
  { fg: '#722ed1', bg: 'rgba(114,46,209,0.14)' },
  { fg: '#08979c', bg: 'rgba(8,151,156,0.14)' },
  { fg: '#389e0d', bg: 'rgba(56,158,13,0.14)' },
  { fg: '#d46b08', bg: 'rgba(212,107,8,0.14)' },
  { fg: '#c41d7f', bg: 'rgba(196,29,127,0.14)' },
]

function tintForId(id: string): ToolTint {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return TINT_POOL[hash % TINT_POOL.length]
}

function resolveToolLook(tool: UserTool): { icon: IconComponent; tint: ToolTint; preset: boolean } {
  const look = tool.presetId != null ? PRESET_LOOK[tool.presetId] : undefined
  if (look) return { ...look, preset: true }
  return { icon: AppstoreOutlined, tint: tintForId(tool.id), preset: false }
}

/** Rounded-square app icon for a tool. Used in list rows (28) and in the
 *  runner / workspace headers (22). */
export function ToolAvatar({ tool, size = 28 }: { tool: UserTool; size?: number }): React.ReactElement {
  const { icon: Icon, tint, preset } = resolveToolLook(tool)
  const initial = tool.name.trim().charAt(0).toUpperCase()
  return (
    <span
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: Math.max(6, Math.round(size * 0.28)),
        background: tint.bg,
        color: tint.fg,
        fontSize: Math.round(size * 0.45),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {preset ? (
        <Icon style={{ fontSize: Math.round(size * 0.52) }} />
      ) : (
        initial || <Icon style={{ fontSize: Math.round(size * 0.52) }} />
      )}
    </span>
  )
}

/** Quiet「预置」label — the tinted avatar already carries the identity, so the
 *  badge stays neutral and small (info, not a call to action). */
export function PresetBadge(): React.ReactElement {
  const { token } = theme.useToken()
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        lineHeight: '15px',
        padding: '0 4px',
        borderRadius: 4,
        background: token.colorFillQuaternary,
        color: token.colorTextTertiary,
        userSelect: 'none',
      }}
    >
      预置
    </span>
  )
}
