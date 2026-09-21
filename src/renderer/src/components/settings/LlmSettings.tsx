import React, { useState, useEffect } from 'react'
import { Collapse, Drawer, Input, InputNumber, Select, Button, Typography, Space, Modal, Popconfirm, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, CheckCircleOutlined, ExclamationCircleFilled, ApiOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { notify, notifyFailure } from '../../utils/notify'
import { probeMissingFields, type LlmProbeOutcome } from '../../../../shared/llm/probe'
import { registerSettingsLeaveGuard } from './settings-leave-guard'
import type { LlmProfile } from '../../types/settings'

const { Text, Title } = Typography

interface LlmSettingsProps {
  open: boolean
  onClose: () => void
  inline?: boolean
}

/** Section caption — one visual rank below the page title, above field labels. */
function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text type="secondary" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
      {children}
    </Text>
  )
}

/** Label + control row, shared by every field so spacing cannot drift. */
function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        {label}
      </Text>
      {children}
    </div>
  )
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
    (localProfile.apiKey || '') !== (savedProfile.apiKey || '') ||
    JSON.stringify(localProfile.headers ?? {}) !== JSON.stringify(savedProfile.headers ?? {})
  )

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
    // Same discard confirm as every other exit path — asks only when dirty.
    void confirmDiscard().then((leave) => {
      if (!leave) return
      setEditingProfileId(profileId)
      setLocalProfile(settings.profiles.find(p => p.id === profileId) ?? null)
    })
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

  // ── Leaving with unsaved edits ──
  // One discard confirm shared by every exit path: drawer close, (inline)
  // the settings page's tab switch via the leave guard, and the editing
  // target switch. Resolves true = leave. A clean profile (nothing edited)
  // leaves without asking — the dialog is about discarding EDITS.
  const confirmDiscard = (): Promise<boolean> => new Promise((resolve) => {
    if (!localProfile || !isDirty) {
      resolve(true)
      return
    }
    Modal.confirm({
      title: t('settingsDrawer.discardChanges'),
      icon: <ExclamationCircleFilled />,
      content: t('settingsDrawer.discardChangesContent', { name: localProfile.name }),
      okText: t('settingsDrawer.discard'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })

  const handleCloseAttempt = (): void => {
    void confirmDiscard().then((leave) => {
      if (leave) onClose()
    })
  }

  // Re-registered on every render so the guard always sees the live dirty
  // state and profile name (no stale closure, no ref bookkeeping).
  useEffect(() => {
    registerSettingsLeaveGuard(confirmDiscard)
    return () => registerSettingsLeaveGuard(null)
  })

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

  // Active profile is named by a Tag inside the selector itself (both in the
  // closed control and in the option list) — there is no separate fake button.
  const profileOptions = settings.profiles.map(p => ({
    value: p.id,
    label: (
      <>
        {p.name}
        {p.id === settings.activeProfileId && (
          <Tag style={{ marginLeft: 8, marginRight: 0 }}>{t('common.active')}</Tag>
        )}
      </>
    ),
  }))

  const normalBody = loading ? (
    <Text type="secondary" style={{ fontSize: 12 }}>{t('common.loading')}</Text>
  ) : (
    <>
      <Text strong style={{ display: 'block', fontSize: 16, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--pm-border-hairline)' }}>{t('settingsDrawer.title')}</Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* ── 配置：切换 / 新建 / 删除 / 名称 ── */}
        <section>
          <SectionLabel>{t('settingsDrawer.sectionConfig')}</SectionLabel>
          {/* 默认模型 semantics (2026-09-21): the drawer's active profile is the
              DEFAULT — new conversations and conversations without their own
              choice run on it; a conversation can pin its own model from the
              composer's picker. The hint says so, or "active" reads as if
              switching here would move every existing conversation. */}
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            {t('settingsDrawer.defaultModelHint')}
          </Text>
          <Space.Compact style={{ width: '100%' }}>
            <Select
              value={editingProfileId}
              onChange={handleEditingProfileChange}
              style={{ flex: 1, minWidth: 0 }}
              options={profileOptions}
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
          {localProfile && (
            <div style={{ marginTop: 12 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('settingsDrawer.profileName')}
              </Text>
              <Input
                placeholder="e.g. My Claude Profile"
                aria-label={t('settingsDrawer.profileName')}
                value={localProfile.name}
                onChange={(e) => setLocalProfile({ ...localProfile, name: e.target.value })}
              />
            </div>
          )}
        </section>

        {/* ── 连接：提供商 / URL / 密钥 / 模型 + 测试，按配置顺序 ── */}
        {localProfile && (
          <section>
            <SectionLabel>{t('settingsDrawer.sectionConnection')}</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Field label={t('settingsDrawer.provider')}>
                <Select
                  value={localProfile.provider ?? 'anthropic'}
                  onChange={(val) => setLocalProfile({ ...localProfile, provider: val as 'anthropic' | 'openai' })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'openai', label: 'OpenAI Compatible' }
                  ]}
                />
              </Field>

              <Field label={t('settingsDrawer.baseURL')}>
                <Input
                  placeholder={(localProfile.provider ?? 'anthropic') === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'}
                  value={localProfile.baseURL}
                  onChange={(e) => setLocalProfile({ ...localProfile, baseURL: e.target.value })}
                />
              </Field>

              <Field label={t('settingsDrawer.apiKey')}>
                <Input.Password
                  placeholder={t('settingsDrawer.apiKeyPlaceholder')}
                  aria-label={t('settingsDrawer.apiKey')}
                  value={localProfile.apiKey || ''}
                  onChange={(e) => setLocalProfile({ ...localProfile, apiKey: e.target.value })}
                />
              </Field>

              <Field label={t('settingsDrawer.model')}>
                <Input
                  placeholder={(localProfile.provider ?? 'anthropic') === 'anthropic' ? 'e.g. claude-sonnet-4-20250514' : 'e.g. gpt-4o'}
                  aria-label={t('settingsDrawer.model')}
                  value={localProfile.model}
                  onChange={(e) => setLocalProfile({ ...localProfile, model: e.target.value })}
                />
              </Field>

              {/* Connectivity test — validates the AS-EDITED fields without saving;
                  the human words (401/404/timeout) come from main (shared/llm/probe.ts).
                  Sits at the end of the connection group so it sees all four values. */}
              <div>
                <Button icon={<ApiOutlined />} loading={probing} onClick={handleTestConnection}>
                  {t('settingsDrawer.testConnection')}
                </Button>
                {probeOutcome && (
                  <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: probeOutcome.ok ? 'var(--pm-success-bg)' : 'var(--pm-error-bg)', border: `1px solid ${probeOutcome.ok ? 'var(--pm-success-border)' : 'var(--pm-error-border)'}` }}>
                    <div style={{ color: probeOutcome.ok ? 'var(--pm-success)' : 'var(--pm-error)', fontSize: 12, fontWeight: 600 }}>
                      {probeOutcome.ok ? '✓ ' : '✕ '}{probeOutcome.message}
                    </div>
                    {probeOutcome.hint && (
                      <div style={{ color: 'var(--pm-text-secondary)', fontSize: 12, marginTop: 2 }}>{probeOutcome.hint}</div>
                    )}
                    {probeOutcome.detail && (
                      <div title={probeOutcome.detail} style={{ color: 'var(--pm-text-soft)', fontSize: 11, marginTop: 2, wordBreak: 'break-all' }}>
                        {probeOutcome.detail.slice(0, 90)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── 高级：调参项默认收起，不与必填项竞争 ── */}
        {localProfile && (
          <Collapse
            ghost
            items={[{
              key: 'advanced',
              label: t('settingsDrawer.sectionAdvanced'),
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <Field label={t('settingsDrawer.maxTokens')}>
                    <InputNumber
                      min={1024}
                      max={131072}
                      step={1024}
                      value={localProfile.maxTokens}
                      onChange={(val) => setLocalProfile({ ...localProfile, maxTokens: val ?? 32768 })}
                      style={{ width: '100%' }}
                    />
                  </Field>

                  <Field label={t('settingsDrawer.contextLength')}>
                    <InputNumber
                      min={4096}
                      max={10000000}
                      step={4096}
                      value={localProfile.contextLength}
                      onChange={(val) => setLocalProfile({ ...localProfile, contextLength: val ?? undefined })}
                      style={{ width: '100%' }}
                    />
                  </Field>

                  <Field label={t('settingsDrawer.customHeaders')}>
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
                  </Field>
                </div>
              ),
            }]}
          />
        )}
      </div>
    </>
  )

  // ── Footer action bar: the page's only commit area ──
  // Left: dirty hint; right: 使用此配置 (only when editing a non-active
  // profile) + 保存配置 (primary, enabled while dirty). When the editing
  // target IS the active profile the footer is save-only.
  const showUseButton = localProfile !== null && editingProfileId !== settings.activeProfileId
  const footer = localProfile ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text type="secondary" style={{ fontSize: 12, flex: 1, visibility: isDirty ? 'visible' : 'hidden' }}>
        {t('settingsDrawer.unsavedHint')}
      </Text>
      {showUseButton && (
        <Button icon={<CheckCircleOutlined />} onClick={handleUseProfile}>
          {t('settingsDrawer.useThisProfile')}
        </Button>
      )}
      <Button
        type="primary"
        icon={<SaveOutlined />}
        loading={saving}
        disabled={!isDirty}
        onClick={handleSaveProfile}
      >
        {isDirty ? t('settingsDrawer.saveProfile') : t('settingsDrawer.saved')}
      </Button>
    </div>
  ) : null

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
        {/* marginBottom cancels the pane wrapper's bottom padding so the bar
            lands flush at scroll end; sticky keeps it visible mid-scroll. */}
        <div style={{ marginBottom: -24 }}>
          {bodyContent}
          {footer && (
            <div
              style={{
                position: 'sticky',
                bottom: 0,
                zIndex: 1,
                margin: '16px -24px 0',
                padding: '12px 24px 16px',
                borderTop: '1px solid var(--pm-border-hairline)',
                background: 'var(--pm-bg)',
              }}
            >
              {footer}
            </div>
          )}
        </div>
        {newProfileModal}
      </>
    )
  }

  return (
    <>
      <Drawer title={t('settingsDrawer.title')} open={open} onClose={handleCloseAttempt} size={400} footer={footer}>
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
