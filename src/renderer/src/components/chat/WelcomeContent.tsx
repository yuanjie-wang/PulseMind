import React, { useCallback, useState } from 'react'
import { Typography, Button, Tooltip, Select } from 'antd'
import { KeyOutlined, ArrowRightOutlined, InfoCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import { useNewTaskStore } from '../../stores/newTaskStore'
import { ProjectDrawer } from '../project/ProjectDrawer'
import type { Project } from '../../../../shared/types/project'
import pulsemindLogo from '../../assets/pulseMind-black.png'

const LOGO_SIZE_WIDTH = 120
const LOGO_SIZE_HEIGHT = 90
const SCROLL_CYCLES = 2
const SCROLL_DURATION = 2
const PAUSE_DURATION = 5
const CYCLE_DURATION = SCROLL_DURATION * SCROLL_CYCLES + PAUSE_DURATION
const COPIES = SCROLL_CYCLES + 1
const P1 = (SCROLL_DURATION / CYCLE_DURATION) * 100
const P2 = (SCROLL_DURATION * SCROLL_CYCLES / CYCLE_DURATION) * 100

export function WelcomeContent({
  greeting,
  hasApiKey,
  onOpenSettings,
  onOpenAbout,
  animName,
  workspaceBaseDir
}: {
  greeting?: string | null
  hasApiKey: boolean
  onOpenSettings?: () => void
  onOpenAbout?: () => void
  animName: string
  /** Global workspace dir — plain conversations mint a timestamped folder under it (M8.4). */
  workspaceBaseDir?: string
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const { mode, projectId, setProjectId } = useNewTaskStore()
  const [projects, setProjects] = useState<Project[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Project options load lazily when the picker opens (and after the create
  // drawer saves) — no effect needed, so nothing re-renders on mode flips.
  const reloadProjects = useCallback(async () => {
    try {
      setProjects(await window.electronAPI.projectList())
    } catch (err) {
      console.warn('[WelcomeContent] project list failed:', err)
    }
  }, [])

  return (
    <div style={{ textAlign: 'center', padding: '24px', marginTop: -100, width: '100%' }}>
      <style>{`@keyframes ${animName} {
        0%   { transform: translateX(0); }
        ${P1.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * 1}px); }
        ${P2.toFixed(4)}% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
        100% { transform: translateX(-${LOGO_SIZE_WIDTH * SCROLL_CYCLES}px); }
      }`}</style>
      <div style={{ overflow: 'hidden', width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, margin: '0 auto 16px', borderRadius: 8 }}>
        <div style={{
          display: 'flex',
          fontSize: 0,
          lineHeight: 0,
          width: LOGO_SIZE_WIDTH * COPIES,
          animation: `${animName} ${CYCLE_DURATION}s linear infinite`
        }}>
          {Array.from({ length: COPIES }).map((_, i) => (
            <img key={i} src={pulsemindLogo} alt="" style={{ width: LOGO_SIZE_WIDTH, height: LOGO_SIZE_HEIGHT, flexShrink: 0, objectFit: 'cover' }} />
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ maxWidth: '80%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Typography.Title key={greeting || 'default-title'} level={2} style={{ margin: 0, animation: 'greetingIn 0.6s ease' }}>
            {greeting || t("welcome.title")}
          </Typography.Title>
        </div>
        <Tooltip title="此内容由AI生成">
          <InfoCircleOutlined style={{ fontSize: 12, color: '#bbb', cursor: 'help', marginTop: 4 }} />
        </Tooltip>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 16, maxWidth: 400, display: 'block', margin: '0 auto', marginBottom: 24, marginTop: 20 }}>
        {t('welcome.subtitle')}
        <Tooltip title={t('welcome.about')}>
          <ArrowRightOutlined
            style={{ marginLeft: 8, cursor: 'pointer', color: 'inherit', fontSize: 14 }}
            onClick={() => onOpenAbout?.()}
          />
        </Tooltip>
      </Typography.Text>

      {/* Task form is picked by the capsule switcher at the top of the view
          (moved out of this component in M8.4-rev); this block reacts to it.
          Nothing is created here — the choice is consumed on the first message. */}

      {mode === 'chat' && workspaceBaseDir && (
        <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 460, margin: '0 auto 20px', fontSize: 12 }}>
          {t('welcome.workspaceHint', { dir: workspaceBaseDir })}
        </Typography.Text>
      )}

      {mode === 'project' && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 240, textAlign: 'left' }}
            placeholder={t('welcome.selectProject')}
            value={projectId ?? undefined}
            onChange={(v) => setProjectId(v)}
            onOpenChange={(open) => { if (open) void reloadProjects() }}
            notFoundContent={t('welcome.noProjects')}
            options={projects.filter((p) => p.id !== 'default').map((p) => ({ value: p.id, label: p.name }))}
          />
          <Button icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
            {t('welcome.newProject')}
          </Button>
          <Button type="text" size="small" onClick={() => navigate({ kind: 'project' })}>
            {t('welcome.manageProjects')}
          </Button>
        </div>
      )}
      <ProjectDrawer
        open={drawerOpen}
        editing={null}
        onClose={() => setDrawerOpen(false)}
        onSaved={(project) => {
          void reloadProjects()
          if (project) setProjectId(project.id)
        }}
      />

      {!hasApiKey && (
        <div style={{
          background: '#fff7e6',
          border: '1px solid #ffd591',
          borderRadius: 8,
          padding: '16px 24px',
          marginBottom: 24,
          maxWidth: 400,
          textAlign: 'center',
          display: 'inline-block'
        }}>
          <p style={{ margin: '0 0 12px', color: '#d46b08' }}>
            <KeyOutlined /> {t('welcome.noApiKey')}
          </p>
          <Button type="primary" onClick={onOpenSettings} icon={<KeyOutlined />}>
            {t('welcome.configureApiKey')}
          </Button>
        </div>
      )}

    </div>
  )
}
