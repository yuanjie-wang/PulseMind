import React, { useState, useEffect } from 'react'
import { Drawer, Input, InputNumber, Select, Button, Typography, Space, Modal, Popconfirm, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, CheckCircleOutlined, ExclamationCircleFilled, ApiOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { notify, notifyFailure } from '../../utils/notify'
import { probeMissingFields, type LlmProbeOutcome } from '../../../../shared/llm/probe'
import type { LlmProfile } from '../../types/settings'

const { Text, Title } = Typography

interface LlmSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

function LlmSettings({ open, onClose, inline }: LlmSettingsProps): React.ReactElement {
  const {
    settings, loading, saving,
    switchProfile, addProfile, saveProfile, deleteProfile, saveAndSwitchProfile
  } = useSettings()

  const [editingProfileId, setEditingProfileId] = useState<string>('')
  const [localProfile, setLocalProfile] = useState<LlmProfile | null>(null)
  const { t } = useTranslation()

  // ── Connectivity test ──
  // Tests the profile AS EDITED (inline fields, not the saved row), so the
  // user can validate before saving. The human words live main-side
  // (shared/llm/probe.ts); here we only render outcome message + hint.
  const [probing, setProbing] = useState(false)
  const [probeOutcome, setProbeOutcome] = useState<LlmProbeOutcome | null>(null)
  const handleTestConnection = async (): Promise<void> => {
    if (!localProfile) return
    const missing = probeMissingFields(localProfile)
    if (missing) {
      notify.warning(t('settingsDrawer.probeIncomplete', { field: missing }))
      return
    }
    setProbing(true)
    try {
      const outcome = await window.electronAPI.testLlmConnection({
        provider: localProfile.provider,
        baseURL: localProfile.baseURL,
        apiKey: localProfile.apiKey,
        model: localProfile.model,
        headers: localProfile.headers,
      })
      setProbeOutcome(outcome)
    } catch (err) {
      notifyFailure('llm-probe', err, t('settingsDrawer.probeCallFailed'))
      setProbeOutcome(null)
    } finally {
      setProbing(false)
    }
  }

  // Custom headers editor: local rows synced to localProfile.headers
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([])

  // Dirty state: local edits differ from persisted profile
  const savedProfile = settings.profiles.find(p => p.id === editingProfileId)
  const isDirty = localProfile !== null && savedProfile !== undefined && (
    localProfile.name !== savedProfile.name ||
    (localProfile.provider ?? 'anthropic') !== (savedProfile.provider ?? 'anthropic') ||
    localProfile.baseURL !== savedProfile.baseURL ||
    localProfile.model !== savedProfile.model ||
    localProfile.maxTokens !== savedProfile.maxTokens ||
    localProfile.contextLength !== savedProfile.contextLength ||
    localProfile.apiKey !== (savedProfile.apiKey || '') ||
    JSON.stringify(localProfile.headers ?? {}) !== JSON.stringify(savedProfile.headers ?? {})
  )

  // Disable "Use This Profile" when editing the already-active profile
  const useProfileDisabled = editingProfileId === settings.activeProfileId

  // "New profile" modal
  const [newProfileOpen, setNewProfileOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')

  // When drawer opens, init editing to the active profile.
  // Does NOT re-sync on every settings change — allows editing a non-active
  // profile without the active-profile switch resetting local state.
  useEffect(() => {
    if (open) {
      const pid = settings.activeProfileId
      setEditingProfileId(pid)
      setLocalProfile(settings.profiles.find(p => p.id === pid) ?? null)
    }
  }, [open])

  // If the editing profile is deleted (no longer in profiles), reset to active
  useEffect(() => {
    if (!editingProfileId) return
    const stillExists = settings.profiles.some(p => p.id === editingProfileId)
    if (!stillExists) {
      const nextId = settings.activeProfileId
      setEditingProfileId(nextId)
      setLocalProfile(settings.profiles.find(p => p.id === nextId) ?? null)
    }
  }, [settings.profiles])

  // Reload header rows whenever a different profile is loaded into localProfile
  useEffect(() => {
    setHeaderRows(
      localProfile?.headers
        ? Object.entries(localProfile.headers).map(([k, v]) => ({ key: k, value: v }))
        : []
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localProfile?.id])

  const handleSaveProfile = async (): Promise<boolean> => {
    if (!localProfile) return false
    // Validate required fields
    if (!localProfile.baseURL.trim()) {
      notify.warning(t('settingsDrawer.enterBaseURL'))
      return false
    }
    if (!localProfile.model.trim()) {
      notify.warning(t('settingsDrawer.enterModel'))
      return false
    }
    try {
      await saveProfile(localProfile.id, localProfile)
      notify.success(t('settingsDrawer.profileSaved'))
      return true
    } catch {
      notify.error(t('settingsDrawer.profileSaveFailed'))
      return false
    }
  }

  const handleAddProfile = async () => {
    const name = newProfileName.trim()
    if (!name) return
    const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const profile: LlmProfile = {
      id,
      name,
      provider: 'anthropic',
      baseURL: '',
      model: '',
      maxTokens: 32768,
      contextLength: 65536
    }
    try {
      await addProfile(profile)
      setEditingProfileId(id)
      setLocalProfile(profile)
      setNewProfileOpen(false)
      setNewProfileName('')
      notify.success(t('settingsDrawer.profileCreated', { name }))
    } catch {
      notify.error(t('settingsDrawer.profileCreateFailed'))
    }
  }

  const handleDeleteProfile = async () => {
    if (!localProfile) return
    if (settings.profiles.length <= 1) {
      notify.warning(t('settingsDrawer.deleteLast'))
      return
    }
    try {
      await deleteProfile(localProfile.id)
      notify.success(t('settingsDrawer.profileDeleted', { name: localProfile.name }))
    } catch {
      notify.error(t('settingsDrawer.profileDeleteFailed'))
    }
  }

  const handleEditingProfileChange = (profileId: string) => {
    // Warn about unsaved changes before switching editing target
    if (isDirty && localProfile) {
      Modal.confirm({
        title: t('settingsDrawer.discardChanges'),
        icon: <ExclamationCircleFilled />,
        content: t('settingsDrawer.discardChangesContent', { name: localProfile.name }),
        okText: t('settingsDrawer.discard'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: () => {
          setEditingProfileId(profileId)
          setLocalProfile(settings.profiles.find(p => p.id === profileId) ?? null)
        }
      })
    } else {
      setEditingProfileId(profileId)
      setLocalProfile(settings.profiles.find(p => p.id === profileId) ?? null)
    }
  }

  const handleUseProfile = async () => {
    if (!localProfile) return

    if (isDirty) {
      // Save edits AND activate the profile in a single atomic update
      console.log(`[LlmSettings] handleUseProfile: saveAndSwitch to "${localProfile.name}"`)
      try {
        await saveAndSwitchProfile(localProfile.id, localProfile)
      } catch {
        notify.error(t('settingsDrawer.profileSwitchFailed'))
        return
      }
    } else if (editingProfileId !== settings.activeProfileId) {
      // No edits needed, just switch
      await switchProfile(editingProfileId)
    }

    onClose()
  }

  // ── Custom headers row helpers ──
  const updateLocalHeaders = (rows: { key: string; value: string }[]): void => {
    setHeaderRows(rows)
    const headers: Record<string, string> = {}
    for (const r of rows) {
      if (r.key.trim()) headers[r.key.trim()] = r.value
    }
    setLocalProfile(prev => prev ? { ...prev, headers } : prev)
  }

  const updateHeaderRow = (idx: number, field: 'key' | 'value', val: string): void => {
    updateLocalHeaders(headerRows.map((r, i) => (i === idx ? { ...r, [field]: val } : r)))
  }

  const removeHeaderRow = (idx: number): void => {
    updateLocalHeaders(headerRows.filter((_, i) => i !== idx))
  }

  const addHeaderRow = (): void => {
    updateLocalHeaders([...headerRows, { key: '', value: '' }])
  }

  // ── Shared body consts ──

  const emptyBody = (
    <div style={{ textAlign: 'center', paddingTop: 60 }}>
      <Title level={4} type="secondary">{t('settingsDrawer.noProfile')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24, fontSize: 12 }}>
        {t('settingsDrawer.noProfileDesc')}
      </Text>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setNewProfileOpen(true)}
      >
        {t('settingsDrawer.createProfile')}
      </Button>
    </div>
  )

  const normalBody = loading ? (
    <Text type="secondary" style={{ fontSize: 12 }}>{t('common.loading')}</Text>
  ) : (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>{t('settingsDrawer.title')}</Text>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
      {/* ── Profile Selector ── */}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          {t('settingsDrawer.profile')}
        </Text>
        <Space.Compact style={{ width: '100%' }}>
          <Select
            value={editingProfileId}
            onChange={handleEditingProfileChange}
            style={{ flex: 1, minWidth: 0 }}
            options={settings.profiles.map(p => ({
              value: p.id,
              label: p.name
            }))}
            optionRender={(option) => (
              <Space>
                {option.data.label}
                {option.data.value === settings.activeProfileId && (
                  <Tag style={{ marginLeft: 8 }}>{t('common.active')}</Tag>
                )}
              </Space>
            )}
          />
          <Button
            icon={<PlusOutlined />}
            onClick={() => setNewProfileOpen(true)}
            aria-label="Add profile"
          />
          <Popconfirm
            title={t('settingsDrawer.deleteConfirm')}
            description={settings.profiles.length <= 1 ? t('settingsDrawer.deleteLast') : undefined}
            onConfirm={handleDeleteProfile}
            okText={t('common.delete')}
            okButtonProps={{ danger: true, disabled: settings.profiles.length <= 1 }}
          >
            <Button
              icon={<DeleteOutlined />}
              danger
              aria-label="Delete profile"
            />
          </Popconfirm>
        </Space.Compact>
      </div>

      {/* ── Use Profile Button ── */}
      {useProfileDisabled ? (
        <Button
          block
          type="default"
          icon={<CheckCircleOutlined />}
          style={{ color: '#333', borderColor: '#d9d9d9' }}
          disabled={false}
        >
          {t('settingsDrawer.activeProfile')}
        </Button>
      ) : (
        <Button
          block
          type="primary"
          ghost
          icon={<SaveOutlined />}
          onClick={handleUseProfile}
        >
          {t('settingsDrawer.useThisProfile')}
        </Button>
      )}

      {/* ── Profile-specific fields ── */}
      {localProfile && (
        <>

          {/* Profile Name */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.profileName')}
            </Text>
            <Input
              placeholder="e.g. My Claude Profile"
              value={localProfile.name}
              onChange={(e) => setLocalProfile({ ...localProfile, name: e.target.value })}
            />
          </div>

          {/* Provider */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.provider')}
            </Text>
            <Select
              value={localProfile.provider ?? 'anthropic'}
              onChange={(val) => setLocalProfile({ ...localProfile, provider: val as 'anthropic' | 'openai' })}
              style={{ width: '100%' }}
              options={[
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'openai', label: 'OpenAI Compatible' }
              ]}
            />
          </div>

          {/* Base URL */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.baseURL')}
            </Text>
            <Input
              placeholder={(localProfile.provider ?? 'anthropic') === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'}
              value={localProfile.baseURL}
              onChange={(e) => setLocalProfile({ ...localProfile, baseURL: e.target.value })}
            />
          </div>

          {/* Model */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('settingsDrawer.model')}</Text>
            <Input
              placeholder={(localProfile.provider ?? 'anthropic') === 'anthropic' ? 'e.g. claude-sonnet-4-20250514' : 'e.g. gpt-4o'}
              value={localProfile.model}
              onChange={(e) => setLocalProfile({ ...localProfile, model: e.target.value })}
            />
          </div>

          {/* Max Tokens */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('settingsDrawer.maxTokens')}</Text>
            <InputNumber
              min={1024}
              max={131072}
              step={1024}
              value={localProfile.maxTokens}
              onChange={(val) => setLocalProfile({ ...localProfile, maxTokens: val ?? 32768 })}
              style={{ width: '100%' }}
            />
          </div>

          {/* Context Length */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('settingsDrawer.contextLength')}</Text>
            <InputNumber
              min={4096}
              max={10000000}
              step={4096}
              value={localProfile.contextLength}
              onChange={(val) => setLocalProfile({ ...localProfile, contextLength: val ?? undefined })}
              style={{ width: '100%' }}
            />
          </div>

          {/* API Key */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.apiKey')}
            </Text>
            <Input.Password
              placeholder={t('settingsDrawer.apiKeyPlaceholder')}
              value={localProfile.apiKey || ''}
              onChange={(e) => setLocalProfile({ ...localProfile, apiKey: e.target.value })}
            />
          </div>

          {/* Connectivity test — validates the AS-EDITED fields without saving;
              the human words (401/404/timeout) come from main (shared/llm/probe.ts). */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.probeTitle')}
            </Text>
            <Button block icon={<ApiOutlined />} loading={probing} onClick={handleTestConnection}>
              {t('settingsDrawer.testConnection')}
            </Button>
            {probeOutcome && (
              <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: probeOutcome.ok ? '#f6ffed' : '#fff2f0', border: `1px solid ${probeOutcome.ok ? '#b7eb8f' : '#ffccc7'}` }}>
                <div style={{ color: probeOutcome.ok ? '#389e0d' : '#cf1322', fontSize: 12, fontWeight: 600 }}>
                  {probeOutcome.ok ? '✓ ' : '✕ '}{probeOutcome.message}
                </div>
                {probeOutcome.hint && (
                  <div style={{ color: '#666', fontSize: 12, marginTop: 2 }}>{probeOutcome.hint}</div>
                )}
                {probeOutcome.detail && (
                  <div title={probeOutcome.detail} style={{ color: '#aaa', fontSize: 11, marginTop: 2, wordBreak: 'break-all' }}>
                    {probeOutcome.detail.slice(0, 90)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Custom Headers */}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              {t('settingsDrawer.customHeaders')}
            </Text>
            <Space orientation="vertical" size="small" style={{ width: '100%' }}>
              {headerRows.map((row, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Input
                    placeholder={t('settingsDrawer.headerKey')}
                    value={row.key}
                    onChange={(e) => updateHeaderRow(idx, 'key', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Input
                    placeholder={t('settingsDrawer.headerValue')}
                    value={row.value}
                    onChange={(e) => updateHeaderRow(idx, 'value', e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    size="small"
                    icon={<DeleteOutlined />}
                    danger
                    onClick={() => removeHeaderRow(idx)}
                    aria-label={t('settingsDrawer.removeHeader')}
                  />
                </div>
              ))}
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={addHeaderRow}
              >
                {t('settingsDrawer.addHeader')}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('settingsDrawer.headersHint')}
              </Text>
            </Space>
          </div>

          {/* Save Profile Button */}
          <Button
            type="primary"
            block
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!isDirty}
            onClick={handleSaveProfile}
          >
            {isDirty ? t('settingsDrawer.saveProfile') : t('settingsDrawer.saved')}
          </Button>

        </>
      )}

    </Space>
    </>
  )

  const bodyContent = (!loading && settings.profiles.length === 0) ? emptyBody : normalBody

  const newProfileModal = (
    <NewProfileModal
      open={newProfileOpen}
      value={newProfileName}
      onChange={setNewProfileName}
      onSubmit={handleAddProfile}
      onCancel={() => { setNewProfileOpen(false); setNewProfileName('') }}
    />
  )

  if (inline) {
    return (
      <>
        <div style={{ height: '100%', overflow: 'auto' }}>
          {bodyContent}
        </div>
        {newProfileModal}
      </>
    )
  }

  return (
    <>
      <Drawer title={t('settingsDrawer.title')} open={open} onClose={onClose} size={400}>
        {bodyContent}
      </Drawer>
      {newProfileModal}
    </>
  )
}

// ── New Profile Modal (extracted for reuse) ──

function NewProfileModal({
  open, value, onChange, onSubmit, onCancel
}: {
  open: boolean
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Modal
      title={t('settingsDrawer.newProfile.title')}
      open={open}
      onOk={onSubmit}
      onCancel={onCancel}
      okText={t('settingsDrawer.newProfile.create')}
      okButtonProps={{ disabled: !value.trim() }}
    >
      <div style={{ marginTop: 8 }}>
        <Text style={{ display: 'block', marginBottom: 8 }}>{t('settingsDrawer.newProfile.name')}</Text>
        <Input
          placeholder="e.g. Anthropic Claude, OpenAI GPT-4o, DeepSeek"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPressEnter={onSubmit}
          autoFocus
        />
      </div>
    </Modal>
  )
}

export default LlmSettings
