// ── Knowledge base rail ──
// The knowledge center's left column: one entry per knowledge base, selection
// IS the scope — the pane threads the selected id into every query, import and
// maintenance action on the right, so a base's documents never mix with
// another's (the old toolbar carried a detached「导入到」dropdown while the
// table listed all bases flat, which is the layout this replaces).
// The default base is always the first entry and carries no actions; create /
// rename / delete live on the rail itself (the「管理知识库」dropdown this
// replaces had no rename entry at all — svcRenameBase was unreachable UI).

import React, { useCallback, useEffect, useState } from 'react'
import { Dropdown, Input, Modal, Typography } from 'antd'
import { MoreOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { KnowledgeManager } from '../../knowledge/KnowledgeManager'
import type { KnowledgeBase } from '../../../../shared/types/knowledge'
import { DEFAULT_BASE_ID } from '../../../../shared/types/knowledge'

const { Text } = Typography

export interface KnowledgeBaseListProps {
  knowledgeManager: KnowledgeManager
  selectedBaseId: string
  onSelectBase: (baseId: string) => void
  /** Bump to re-read the list after imports elsewhere changed file counts
   *  (the pane forwards the panel's stats, which refresh after each import). */
  refreshSignal?: unknown
}

export function KnowledgeBaseList({ knowledgeManager, selectedBaseId, onSelectBase, refreshSignal }: KnowledgeBaseListProps): React.ReactElement {
  const { t } = useTranslation()
  const [bases, setBases] = useState<KnowledgeBase[]>([])
  const [baseModal, setBaseModal] = useState<{ open: boolean; editId?: string; name: string }>({ open: false, name: '' })

  const loadBases = useCallback(async () => {
    try { setBases(await knowledgeManager.listBases()) } catch { /* keep the last list */ }
  }, [knowledgeManager])

  // Mount + every refreshSignal bump (imports elsewhere change file counts).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loadBases sets state only after its await, outside the sync effect body
  useEffect(() => { void loadBases() }, [loadBases, refreshSignal])

  const handleCreate = async (): Promise<void> => {
    try {
      const created = await knowledgeManager.createBase(baseModal.name)
      setBaseModal({ open: false, name: '' })
      await loadBases()
      // A base the user just named is the base they want to look at.
      onSelectBase(created.id)
    } catch (err) {
      Modal.error({ title: '操作失败', content: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleRename = async (): Promise<void> => {
    if (!baseModal.editId) return
    try {
      await knowledgeManager.renameBase(baseModal.editId, baseModal.name)
      setBaseModal({ open: false, name: '' })
      await loadBases()
    } catch (err) {
      Modal.error({ title: '操作失败', content: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleDelete = (base: KnowledgeBase): void => {
    Modal.confirm({
      title: t('knowledgePanel.baseDeleteConfirmTitle'),
      // The store's delete really removes the files (probe-knowledge-base
      // asserts it); the confirm says so — the old「文件回到默认库」wording
      // described a behaviour the backend never had.
      content: t('knowledgePanel.baseDeleteConfirmContent', { name: base.name, n: base.fileCount ?? 0 }),
      okText: t('knowledgePanel.baseDelete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await knowledgeManager.deleteBase(base.id)
          if (selectedBaseId === base.id) onSelectBase(DEFAULT_BASE_ID)
          await loadBases()
        } catch (err) {
          Modal.error({ title: '操作失败', content: err instanceof Error ? err.message : String(err) })
        }
      },
    })
  }

  return (
    <div
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: '1px solid #f0f0f0',
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 8px 12px',
        minHeight: 0,
      }}
      data-knowledge-base-list
    >
      <div style={{ padding: '0 12px 8px', fontSize: 13, fontWeight: 600, color: '#333' }}>
        {t('knowledgePanel.title')}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {bases.map((b) => {
          const selected = b.id === selectedBaseId
          const deletable = b.id !== DEFAULT_BASE_ID
          return (
            <div
              key={b.id}
              data-base-item={b.id}
              data-base-selected={selected || undefined}
              onClick={() => { if (!selected) onSelectBase(b.id) }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 8px 8px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                color: '#333',
                transition: 'background 0.15s',
                background: selected ? '#f0f0f0' : 'transparent',
              }}
              onMouseEnter={(e) => {
                const dot = e.currentTarget.querySelector<HTMLDivElement>('[data-base-actions]')
                if (dot) dot.style.opacity = '1'
                if (!selected) e.currentTarget.style.background = '#f5f5f5'
              }}
              onMouseLeave={(e) => {
                const dot = e.currentTarget.querySelector<HTMLDivElement>('[data-base-actions]')
                if (dot) dot.style.opacity = '0'
                if (!selected) e.currentTarget.style.background = 'transparent'
              }}
            >
              {/* Identity color: the base's stored colorHue (assigned from its
                  name at creation, same hash-color family as project cards). */}
              <span
                data-base-dot={b.id}
                style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: `hsl(${b.colorHue ?? 0}, 65%, 55%)` }}
              />
              <Text style={{ flex: 1, fontSize: 13, minWidth: 0 }} ellipsis={{ tooltip: b.name }}>
                {b.name}
                {b.id === DEFAULT_BASE_ID && (
                  <span
                    data-base-default-tag
                    style={{
                      marginLeft: 6,
                      padding: '0 5px',
                      borderRadius: 4,
                      fontSize: 10,
                      lineHeight: '16px',
                      color: '#999',
                      background: '#f5f5f5',
                      verticalAlign: 'middle',
                    }}
                  >
                    {t('knowledgePanel.baseDefaultTag')}
                  </span>
                )}
              </Text>
              <span style={{ fontSize: 11, color: '#bbb', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {b.fileCount ?? 0}
              </span>
              {deletable && (
                <div data-base-actions={b.id} style={{ flexShrink: 0, opacity: 0, transition: 'opacity 0.15s' }}>
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'rename',
                          label: t('knowledgePanel.baseRename'),
                          onClick: () => setBaseModal({ open: true, editId: b.id, name: b.name }),
                        },
                        { type: 'divider' as const },
                        {
                          key: 'delete',
                          label: t('knowledgePanel.baseDelete'),
                          danger: true,
                          onClick: () => handleDelete(b),
                        },
                      ],
                    }}
                    trigger={['click']}
                  >
                    <span
                      data-base-menu={b.id}
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'inline-flex', padding: '0 2px', color: '#999', cursor: 'pointer', lineHeight: 1 }}
                    >
                      <MoreOutlined style={{ fontSize: 14 }} />
                    </span>
                  </Dropdown>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {/* The create affordance is a dashed card closing the rail — the same
          recipe as the welcome page's 新建项目 card and the routine center's
          新建任务 card. A real <button> so it takes focus and Enter. It opens
          the form only; 保存 writes. */}
      <button
        type="button"
        data-base-new
        onClick={() => setBaseModal({ open: true, name: '' })}
        className="knowledge-base-new"
        style={{
          marginTop: 8,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          width: '100%',
          padding: '9px 0',
          border: '1px dashed #c8c8cc',
          borderRadius: 6,
          background: 'transparent',
          color: '#999',
          fontSize: 13,
          cursor: 'pointer',
          font: 'inherit',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#666'
          e.currentTarget.style.color = '#666'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#c8c8cc'
          e.currentTarget.style.color = '#999'
        }}
      >
        <PlusOutlined style={{ fontSize: 12 }} />
        {t('knowledgePanel.baseNew')}
      </button>

      <Modal
        title={baseModal.editId ? t('knowledgePanel.renameBaseTitle') : t('knowledgePanel.createBaseTitle')}
        open={baseModal.open}
        okText={baseModal.editId ? t('common.save') : t('knowledgePanel.baseCreateOk')}
        cancelText={t('common.cancel')}
        onCancel={() => setBaseModal({ open: false, name: '' })}
        onOk={() => { void (baseModal.editId ? handleRename() : handleCreate()) }}
      >
        <Input
          value={baseModal.name}
          placeholder={t('knowledgePanel.baseNamePlaceholder')}
          maxLength={40}
          onChange={(e) => setBaseModal((m) => ({ ...m, name: e.target.value }))}
        />
      </Modal>
    </div>
  )
}

export default KnowledgeBaseList
