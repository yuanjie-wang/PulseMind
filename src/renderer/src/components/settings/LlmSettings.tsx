import React, { useState, useEffect } from 'react'
import { Collapse, Drawer, Input, InputNumber, Select, Button, Typography, Space, Modal, Popconfirm, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined, SaveOutlined, CheckCircleOutlined, ExclamationCircleFilled, ApiOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useSettings } from '../../hooks/SettingsContext'
import { notify, notifyFailure } from '../../utils/notify'
import { probeMissingFields, type LlmProbeOutcome } from '../../../../shared/llm/probe'
import { registerSettingsLeaveGuard } from './settings-leave-guard'
import type { LlmProviderConfig, LlmModelConfig } from '../../types/settings'

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function newModelEntry(model = ''): LlmModelConfig {
  return {
    id: `model_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    model,
    maxTokens: 32768,
    contextLength: 65536
  }
}

function LlmSettings({ open, onClose, inline }: LlmSettingsProps): React.ReactElement {
  const {
    settings, loading, saving, saveModelConfig
  } = useSettings()

  const { t } = useTranslation()

  // ── Two-layer draft ──
  // The draft is the whole providers array (供应商 → 模型): editing a shared
  // field (baseURL/apiKey/headers) writes ONE provider and lands on every
  // model under it; per-model fields (模型名/maxTokens/…) write one entry.
  // settings.providers is persisted providers only — the merged `profiles`
  // views are re-derived main-side on save.
  const [draftProviders, setDraftProviders] = useState<LlmProviderConfig[]>([])
  const [editingProviderId, setEditingProviderId] = useState<string>('')
  const [editingModelId, setEditingModelId] = useState<string>('')

  // When the drawer opens (and settings finished loading), seed the draft.
  // The editing target starts at the DEFAULT model (settings.activeProfileId
  // is a model entry id) and its provider.
  useEffect(() => {
    if (!open || loading) return
    const providers = clone(settings.providers ?? [])
    const activeProvider = providers.find((p) => (p.models ?? []).some((m) => m.id === settings.activeProfileId))
      ?? providers[0]
    setDraftProviders(providers)
    setEditingProviderId(activeProvider?.id ?? '')
    const activeInProvider = activeProvider?.models?.some((m) => m.id === settings.activeProfileId)
    setEditingModelId(activeInProvider ? settings.activeProfileId : (activeProvider?.models?.[0]?.id ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading])

  const draftProvider = draftProviders.find((p) => p.id === editingProviderId) ?? null
  const draftModel = draftProvider?.models.find((m) => m.id === editingModelId)
    ?? draftProvider?.models[0]
    ?? null

  // Dirty state: the providers draft differs from the persisted one.
  const isDirty = JSON.stringify(draftProviders) !== JSON.stringify(settings.providers ?? [])

  // ── Connectivity test ──
  // Tests the AS-EDITED pair (draft provider connection + selected model), so
  // the user can validate before saving. The human words live main-side
  // (shared/llm/probe.ts); here we only render outcome message + hint.
  const [probing, setProbing] = useState(false)
  const [probeOutcome, setProbeOutcome] = useState<LlmProbeOutcome | null>(null)
  const handleTestConnection = async (): Promise<void> => {
    if (!draftProvider || !draftModel) return
    const missing = probeMissingFields({
      provider: draftProvider.apiFormat,
      baseURL: draftProvider.baseURL,
      apiKey: draftProvider.apiKey,
      model: draftModel.model,
      headers: draftProvider.headers,
    })
    if (missing) {
      notify.warning(t('settingsDrawer.probeIncomplete', { field: missing }))
      return
    }
    setProbing(true)
    try {
      const outcome = await window.electronAPI.testLlmConnection({
        provider: draftProvider.apiFormat,
        baseURL: draftProvider.baseURL,
        apiKey: draftProvider.apiKey,
        model: draftModel.model,
        headers: draftProvider.headers,
      })
      setProbeOutcome(outcome)
    } catch (err) {
      notifyFailure('llm-probe', err, t('settingsDrawer.probeCallFailed'))
      setProbeOutcome(null)
    } finally {
      setProbing(false)
    }
  }

  // Custom headers editor: local rows synced to the draft provider's headers.
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([])
  useEffect(() => {
    setHeaderRows(
      draftProvider?.headers
        ? Object.entries(draftProvider.headers).map(([k, v]) => ({ key: k, value: v }))
        : []
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingProviderId])

  const updateDraftProvider = (id: string, patch: Partial<LlmProviderConfig>): void => {
    setDraftProviders((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const updateDraftModel = (providerId: string, modelId: string, patch: Partial<LlmModelConfig>): void => {
    setDraftProviders((list) => list.map((p) => (
      p.id === providerId
        ? { ...p, models: p.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) }
        : p
    )))
  }

  // ── Custom headers row helpers ──
  const updateLocalHeaders = (rows: { key: string; value: string }[]): void => {
    setHeaderRows(rows)
    if (!draftProvider) return
    const headers: Record<string, string> = {}
    for (const r of rows) {
      if (r.key.trim()) headers[r.key.trim()] = r.value
    }
    updateDraftProvider(draftProvider.id, { headers })
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

  // ── Provider / model CRUD on the draft ──

  // "New provider" modal — a provider is born with one empty model so the
  // 模型 section below has something to edit right away.
  const [newProviderOpen, setNewProviderOpen] = useState(false)
  const [newProviderName, setNewProviderName] = useState('')

  const handleAddProvider = () => {
    const name = newProviderName.trim()
    if (!name) return
    const provider: LlmProviderConfig = {
      id: `prov_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      apiFormat: 'openai',
      baseURL: '',
      models: [newModelEntry()]
    }
    setDraftProviders((list) => [...list, provider])
    setEditingProviderId(provider.id)
    setEditingModelId(provider.models[0].id)
    setProbeOutcome(null)
    setNewProviderOpen(false)
    setNewProviderName('')
    notify.success(t('settingsDrawer.providerCreated', { name }))
  }

  const handleDeleteProvider = async () => {
    if (!draftProvider) return
    if (draftProviders.length <= 1) {
      notify.warning(t('settingsDrawer.deleteLastProvider'))
      return
    }
    const name = draftProvider.name
    const remaining = draftProviders.filter((p) => p.id !== draftProvider.id)
    setDraftProviders(remaining)
    const next = remaining[0]
    setEditingProviderId(next.id)
    setEditingModelId(next.models[0]?.id ?? '')
    setProbeOutcome(null)
    notify.success(t('settingsDrawer.providerDeleted', { name }))
  }

  const handleAddModel = () => {
    if (!draftProvider) return
    const entry = newModelEntry()
    updateDraftProvider(draftProvider.id, { models: [...draftProvider.models, entry] })
    setEditingModelId(entry.id)
    setProbeOutcome(null)
  }

  const handleDeleteModel = () => {
    if (!draftProvider || !draftModel) return
    const remaining = draftProvider.models.filter((m) => m.id !== draftModel.id)
    updateDraftProvider(draftProvider.id, { models: remaining })
    setEditingModelId(remaining[0]?.id ?? '')
    setProbeOutcome(null)
  }

  // ── Save / use ──
  const validateDraft = (): boolean => {
    if (!draftProvider) return false
    if (!draftProvider.baseURL.trim()) {
      notify.warning(t('settingsDrawer.enterBaseURL'))
      return false
    }
    if (draftProvider.models.length === 0 || draftProvider.models.some((m) => !m.model.trim())) {
      notify.warning(t('settingsDrawer.enterModel'))
      return false
    }
    return true
  }

  const handleSave = async (): Promise<boolean> => {
    if (!validateDraft()) return false
    try {
      await saveModelConfig(draftProviders)
      notify.success(t('settingsDrawer.modelSaved'))
      return true
    } catch {
      notify.error(t('settingsDrawer.modelSaveFailed'))
      return false
    }
  }

  // 设为默认模型：save the draft AND point settings.activeProfileId at the
  // selected model in one write (main re-derives the merged views).
  const handleUseModel = async () => {
    if (!draftModel) return
    if (!validateDraft()) return
    try {
      await saveModelConfig(draftProviders, draftModel.id)
      notify.success(t('settingsDrawer.modelSaved'))
    } catch {
      notify.error(t('settingsDrawer.modelSaveFailed'))
      return
    }
    onClose()
  }

  const switchEditingProvider = (providerId: string) => {
    // Same discard confirm as every other exit path — asks only when dirty.
    void confirmDiscard().then((leave) => {
      if (!leave) return
      const next = draftProviders.find((p) => p.id === providerId)
      setEditingProviderId(providerId)
      setEditingModelId(next?.models[0]?.id ?? '')
      setProbeOutcome(null)
    })
  }

  const switchEditingModel = (modelId: string) => {
    void confirmDiscard().then((leave) => {
      if (!leave) return
      setEditingModelId(modelId)
      setProbeOutcome(null)
    })
  }

  // ── Leaving with unsaved edits ──
  // One discard confirm shared by every exit path: drawer close, (inline)
  // the settings page's tab switch via the leave guard, and the editing
  // target switch. Resolves true = leave. A clean draft (nothing edited)
  // leaves without asking — the dialog is about discarding EDITS.
  const confirmDiscard = (): Promise<boolean> => new Promise((resolve) => {
    if (!isDirty) {
      resolve(true)
      return
    }
    Modal.confirm({
      title: t('settingsDrawer.discardChanges'),
      icon: <ExclamationCircleFilled />,
      content: t('settingsDrawer.discardChangesContent'),
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
  // state (no stale closure, no ref bookkeeping).
  useEffect(() => {
    registerSettingsLeaveGuard(confirmDiscard)
    return () => registerSettingsLeaveGuard(null)
  })

  // ── Shared body consts ──

  const emptyBody = (
    <div style={{ textAlign: 'center', paddingTop: 60 }}>
      <Title level={4} type="secondary">{t('settingsDrawer.noProviders')}</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24, fontSize: 12 }}>
        {t('settingsDrawer.providerHint')}
      </Text>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setNewProviderOpen(true)}
      >
        {t('settingsDrawer.addProvider')}
      </Button>
    </div>
  )

  const providerOptions = draftProviders.map((p) => ({
    value: p.id,
    label: (
      <>
        {p.name}
        {settings.activeProfileId && (p.models ?? []).some((m) => m.id === settings.activeProfileId) && (
          <Tag style={{ marginLeft: 8, marginRight: 0 }}>{t('common.active')}</Tag>
        )}
      </>
    ),
  }))

  const modelOptions = (draftProvider?.models ?? []).map((m) => ({
    value: m.id,
    label: (
      <>
        {m.name || m.model || t('settingsDrawer.modelName')}
        {m.id === settings.activeProfileId && (
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
        {/* ── 供应商：连接层（接口规范 / URL / 密钥被名下模型共享） ── */}
        {draftProvider && (
          <section>
            <SectionLabel>{t('settingsDrawer.providerSection')}</SectionLabel>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              {t('settingsDrawer.providerHint')}
            </Text>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                value={editingProviderId}
                onChange={switchEditingProvider}
                style={{ flex: 1, minWidth: 0 }}
                options={providerOptions}
              />
              <Button
                icon={<PlusOutlined />}
                onClick={() => setNewProviderOpen(true)}
                aria-label={t('settingsDrawer.addProvider')}
              />
              <Popconfirm
                title={t('settingsDrawer.deleteProviderConfirm')}
                description={draftProviders.length <= 1 ? t('settingsDrawer.deleteLastProvider') : undefined}
                onConfirm={handleDeleteProvider}
                okText={t('common.delete')}
                okButtonProps={{ danger: true, disabled: draftProviders.length <= 1 }}
              >
                <Button
                  icon={<DeleteOutlined />}
                  danger
                  aria-label="Delete provider"
                />
              </Popconfirm>
            </Space.Compact>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
              <Field label={t('settingsDrawer.providerName')}>
                <Input
                  placeholder="e.g. DeepSeek"
                  aria-label={t('settingsDrawer.providerName')}
                  value={draftProvider.name}
                  onChange={(e) => updateDraftProvider(draftProvider.id, { name: e.target.value })}
                />
              </Field>

              <Field label={t('settingsDrawer.apiFormat')}>
                <Select
                  value={draftProvider.apiFormat ?? 'anthropic'}
                  onChange={(val) => updateDraftProvider(draftProvider.id, { apiFormat: val as 'anthropic' | 'openai' })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'openai', label: 'OpenAI Compatible' }
                  ]}
                />
              </Field>

              <Field label={t('settingsDrawer.baseURL')}>
                <Input
                  placeholder={draftProvider.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'}
                  value={draftProvider.baseURL}
                  onChange={(e) => updateDraftProvider(draftProvider.id, { baseURL: e.target.value })}
                />
              </Field>

              <Field label={t('settingsDrawer.apiKey')}>
                <Input.Password
                  placeholder={t('settingsDrawer.apiKeyPlaceholder')}
                  aria-label={t('settingsDrawer.apiKey')}
                  value={draftProvider.apiKey || ''}
                  onChange={(e) => updateDraftProvider(draftProvider.id, { apiKey: e.target.value })}
                />
              </Field>

              {/* Custom headers — advanced (default collapsed) */}
              <Collapse
                ghost
                items={[{
                  key: 'headers',
                  label: t('settingsDrawer.customHeaders'),
                  children: (
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
                  ),
                }]}
              />

              {/* Connectivity test — validates the AS-EDITED provider+model
                  pair without saving; the human words (401/404/timeout) come
                  from main (shared/llm/probe.ts). */}
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

        {/* ── 模型：属于上方供应商，连接信息复用，参数独立 ── */}
        {draftProvider && (
          <section>
            <SectionLabel>{t('settingsDrawer.modelSection')}</SectionLabel>
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              {t('settingsDrawer.modelHint')}
            </Text>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                value={draftModel?.id ?? ''}
                onChange={switchEditingModel}
                style={{ flex: 1, minWidth: 0 }}
                placeholder={t('settingsDrawer.noModels')}
                options={modelOptions}
              />
              <Button
                icon={<PlusOutlined />}
                onClick={handleAddModel}
                aria-label={t('settingsDrawer.addModel')}
              />
              <Popconfirm
                title={t('settingsDrawer.deleteModelConfirm')}
                onConfirm={handleDeleteModel}
                okText={t('common.delete')}
                okButtonProps={{ danger: true, disabled: !draftModel }}
              >
                <Button
                  icon={<DeleteOutlined />}
                  danger
                  disabled={!draftModel}
                  aria-label="Delete model"
                />
              </Popconfirm>
            </Space.Compact>
            {draftModel && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
                <Field label={t('settingsDrawer.modelName')}>
                  <Input
                    placeholder={draftProvider.apiFormat === 'anthropic' ? 'e.g. claude-sonnet-4-20250514' : 'e.g. gpt-4o'}
                    aria-label={t('settingsDrawer.modelName')}
                    value={draftModel.model}
                    onChange={(e) => updateDraftModel(draftProvider.id, draftModel.id, { model: e.target.value })}
                  />
                </Field>

                <Field label={t('settingsDrawer.modelDisplayName')}>
                  <Input
                    placeholder={t('settingsDrawer.modelDisplayNamePlaceholder')}
                    aria-label={t('settingsDrawer.modelDisplayName')}
                    value={draftModel.name ?? ''}
                    onChange={(e) => updateDraftModel(draftProvider.id, draftModel.id, { name: e.target.value || undefined })}
                  />
                </Field>

                <Field label={t('settingsDrawer.maxTokens')}>
                  <InputNumber
                    min={1024}
                    max={131072}
                    step={1024}
                    value={draftModel.maxTokens}
                    onChange={(val) => updateDraftModel(draftProvider.id, draftModel.id, { maxTokens: val ?? 32768 })}
                    style={{ width: '100%' }}
                  />
                </Field>

                <Field label={t('settingsDrawer.contextLength')}>
                  <InputNumber
                    min={4096}
                    max={10000000}
                    step={4096}
                    value={draftModel.contextLength}
                    onChange={(val) => updateDraftModel(draftProvider.id, draftModel.id, { contextLength: val ?? undefined })}
                    style={{ width: '100%' }}
                  />
                </Field>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )

  // ── Footer action bar: the page's only commit area ──
  // Left: dirty hint; right: 设为默认模型 (only when the editing model is not
  // the default) + 保存配置 (primary, enabled while dirty).
  const showUseButton = !!draftModel && draftModel.id !== settings.activeProfileId
  const footer = draftProvider ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Text type="secondary" style={{ fontSize: 12, flex: 1, visibility: isDirty ? 'visible' : 'hidden' }}>
        {t('settingsDrawer.unsavedHint')}
      </Text>
      {showUseButton && (
        <Button icon={<CheckCircleOutlined />} onClick={handleUseModel}>
          {t('settingsDrawer.useThisProfile')}
        </Button>
      )}
      <Button
        type="primary"
        icon={<SaveOutlined />}
        loading={saving}
        disabled={!isDirty}
        onClick={handleSave}
      >
        {isDirty ? t('settingsDrawer.saveProfile') : t('settingsDrawer.saved')}
      </Button>
    </div>
  ) : null

  const bodyContent = (!loading && draftProviders.length === 0) ? emptyBody : normalBody

  const newProviderModal = (
    <NewProviderModal
      open={newProviderOpen}
      value={newProviderName}
      onChange={setNewProviderName}
      onSubmit={handleAddProvider}
      onCancel={() => { setNewProviderOpen(false); setNewProviderName('') }}
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
        {newProviderModal}
      </>
    )
  }

  return (
    <>
      <Drawer title={t('settingsDrawer.title')} open={open} onClose={handleCloseAttempt} size={400} footer={footer}>
        {bodyContent}
      </Drawer>
      {newProviderModal}
    </>
  )
}

// ── New Provider Modal (extracted for reuse) ──

function NewProviderModal({
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
      title={t('settingsDrawer.newProvider.title')}
      open={open}
      onOk={onSubmit}
      onCancel={onCancel}
      okText={t('settingsDrawer.newProvider.create')}
      okButtonProps={{ disabled: !value.trim() }}
    >
      <div style={{ marginTop: 8 }}>
        <Text style={{ display: 'block', marginBottom: 8 }}>{t('settingsDrawer.newProvider.name')}</Text>
        <Input
          placeholder="e.g. Anthropic, DeepSeek, OpenRouter"
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
