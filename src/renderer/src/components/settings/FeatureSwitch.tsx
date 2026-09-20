// ── Feature master switch ──
// Shared by the settings 记忆/经验 sections: a labeled on/off row that writes
// straight to settings.json via useSettings. The feature gates read the flag
// from there (main-side managers sync in settings.handler, renderer-side in App).

import React from 'react'
import { Switch, Typography } from 'antd'

const { Text } = Typography

interface FeatureSwitchProps {
  label: string
  help: string
  checked: boolean
  onChange: (checked: boolean) => void
}

function FeatureSwitch({ label, help, checked, onChange }: FeatureSwitchProps): React.ReactElement {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      padding: '10px 12px',
      border: '1px solid var(--pm-border-hairline)',
      borderRadius: 8,
      background: 'var(--pm-wash)',
      marginBottom: 12
    }}>
      <div style={{ minWidth: 0 }}>
        <Text strong style={{ display: 'block', fontSize: 13 }}>{label}</Text>
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>{help}</Text>
      </div>
      <Switch checked={checked} onChange={onChange} style={{ flexShrink: 0, marginTop: 2 }} />
    </div>
  )
}

export default FeatureSwitch
