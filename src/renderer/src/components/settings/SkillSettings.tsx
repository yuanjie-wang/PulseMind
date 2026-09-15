import React from 'react'
import { Alert } from 'antd'
import SkillsPanel from './SkillsPanel'
import type { SkillState } from '../../skills/types'

interface SkillSettingsProps {
  skills: SkillState[]
  onToggleSkill: (name: string) => void
  onDeleteSkill?: (name: string) => void
  importError?: string | null
}

/** Embedded skills panel; its title-row actions (refresh / import) are rendered
 *  by the capability center's pill row from the same callbacks. */
function SkillSettings({
  skills,
  onToggleSkill,
  onDeleteSkill,
  importError
}: SkillSettingsProps): React.ReactElement {
  return (
    // No overflow of its own — the capability center's pane scrolls (see its comment).
    <div style={{ height: '100%' }}>
      {importError && (
        <Alert
          message={importError}
          type="error"
          showIcon
          style={{ fontSize: 12, marginBottom: 12 }}
        />
      )}

      <SkillsPanel
        skills={skills}
        onToggleSkill={onToggleSkill}
        onDeleteSkill={onDeleteSkill}
      />
    </div>
  )
}

export default SkillSettings
