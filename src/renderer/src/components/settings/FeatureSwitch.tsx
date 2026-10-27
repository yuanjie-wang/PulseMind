// ── Settings card + feature master switch ──
// SettingCard is the one chrome every section of the 记忆 panel wears (title,
// help, an optional control on the right, and the section body below a hairline),
// so sibling sections read as peers whether or not they carry a switch.
// FeatureSwitch is SettingCard with a Switch in the control slot; it writes
// straight to settings.json via useSettings and the feature gates read the flag
// from there (main-side managers sync in settings.handler, renderer-side in App).

import React from 'react'
import { Switch, Typography } from 'antd'

const { Text } = Typography

interface SettingCardProps {
  title: string
  help: string
  /** Control rendered on the right of the title row (e.g. a Switch). */
  extra?: React.ReactNode
  children?: React.ReactNode
}

export function SettingCard({ title, help, extra, children }: SettingCardProps): React.ReactElement {
  return (
    <div style={{
      padding: '10px 12px',
      border: '1px solid var(--pm-border-hairline)',
      borderRadius: 8,
      background: 'var(--pm-wash)',
      marginBottom: 12
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <Text strong style={{ display: 'block', fontSize: 13 }}>{title}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{help}</Text>
        </div>
        {extra && <div style={{ flexShrink: 0, marginTop: 2 }}>{extra}</div>}
      </div>
      {children && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--pm-border-hairline)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

interface FeatureSwitchProps {
  label: string
  help: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Sub-settings that only make sense alongside the switch. */
  children?: React.ReactNode
}

function FeatureSwitch({ label, help, checked, onChange, children }: FeatureSwitchProps): React.ReactElement {
  return (
    <SettingCard title={label} help={help} extra={<Switch checked={checked} onChange={onChange} />}>
      {children}
    </SettingCard>
  )
}

export default FeatureSwitch
