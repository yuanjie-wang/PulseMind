/**
 * 语音输入引导卡（PLAN-voice-input §3.5 场景 A / §3.6 场景 B）。
 *
 * 首按无模型 → 麦克风按钮旁弹这张卡：模型名/大小、期望文件名、sha256 前 16 位
 * （可复制，运维核对用）、获取指引链接（helpUrl；空 = 待发布占位文案）与
 * 「导入模型包」按钮（文件选择 → asrImportModel）。导入结果原样展示——
 * hash/版本/家族三道门的可读文案就是主进程给的 message，这里不再加工。
 *
 * 设置页（VoiceSettings）复用同一张卡做「导入」入口；删除入口只给设置页
 * （引导卡是补装模型的形态，不带破坏动作）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Space } from 'antd'
import { ImportOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'

interface CatalogModelLike {
  modelId: string
  displayName: string
  expectedZip: string
  zipSha256: string
  sizeText: string
  helpUrl: string
  installed: boolean
}

export interface VoiceGuideCardProps {
  /** 随包支持清单里的模型条目（ASR_GET_STATE.catalog.models）；缺省 = 组件自取 */
  models?: CatalogModelLike[]
  /** 引擎异常时显示（引擎缺失时导入也救不了听写，先修引擎） */
  engineError?: string | null
  /** 导入成功/删除后的刷新回调（宿主重新拉 state；广播也会驱动） */
  onChanged?: () => void
  /** 紧凑模式：设置页内嵌（引导弹层用默认） */
  compact?: boolean
  /** 允许删除（只给设置页） */
  allowRemove?: boolean
}

/** 从随包清单读一条给引导卡用的数据 */
async function fetchCatalog(): Promise<{ models: CatalogModelLike[]; engineError: string | null } | null> {
  try {
    const state = await window.electronAPI.asrGetState()
    return { models: state.catalog.models, engineError: state.engineError }
  } catch {
    return null
  }
}

export function VoiceGuideCard(props: VoiceGuideCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const { models, engineError, onChanged, allowRemove } = props
  const [importing, setImporting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  // 宿主没有传 models 时的自取（设置页挂载/广播场景）——有传则完全受控。
  // setState 只出现在异步回调里（effect 体本身不做同步 setState）。
  const [self, setSelf] = useState<{ models: CatalogModelLike[]; engineError: string | null } | null>(null)
  useEffect(() => {
    if (models) return
    let alive = true
    const load = (): void => {
      void fetchCatalog().then((r) => {
        if (alive && r) setSelf(r)
      })
    }
    load()
    const off = window.electronAPI.onAsrModelsChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [models])

  const list = models ?? self?.models ?? []
  const engineErr = engineError ?? self?.engineError ?? null
  const first = list[0]
  const installed = list.some((m) => m.installed)

  const importZip = useCallback(async (): Promise<void> => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Model pack (zip)', extensions: ['zip'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return
    setImporting(true)
    try {
      const r = await window.electronAPI.asrImportModel(result.filePaths[0])
      if (r.ok) {
        notify.success(t('voiceInput.imported'))
        onChanged?.()
      } else {
        notify.error(`${t('voiceInput.importFailed')}：${r.message}`)
      }
    } catch (e) {
      notify.error(`${t('voiceInput.importFailed')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setImporting(false)
    }
  }, [onChanged, t])

  const removeModel = useCallback(
    (modelId: string): void => {
      Modal.confirm({
        title: t('voiceInput.guideRemoveConfirm'),
        okButtonProps: { danger: true },
        onOk: async () => {
          const ok = await window.electronAPI.asrRemoveModel(modelId)
          if (ok) onChanged?.()
          return ok
        },
      })
    },
    [onChanged, t],
  )

  const copySha = useCallback(async (sha: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sha)
      setCopied(sha)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      /* clipboard denied — 卡上是明文，用户可手抄 */
    }
  }, [])

  return (
    <div style={{ maxWidth: 420, fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{t('voiceInput.guideTitle')}</div>
      <div style={{ color: 'var(--pm-text-secondary)', marginBottom: 8 }}>
        {first ? t('voiceInput.guideDesc', { size: first.sizeText }) : t('voiceInput.guideDesc', { size: '' })}
      </div>

      {engineErr && (
        <div
          style={{
            background: 'var(--pm-warn-bg, rgba(250,173,20,0.08))',
            borderRadius: 6,
            padding: '6px 8px',
            marginBottom: 8,
            color: 'var(--pm-warn)',
          }}
        >
          {t('voiceInput.engineError')}：{engineErr}
        </div>
      )}

      {first && (
        <>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: 'var(--pm-text-faint)' }}>{t('voiceInput.guideExpectedFile')}：</span>
            <code style={{ userSelect: 'all' }}>{first.expectedZip}</code>
          </div>
          {first.zipSha256 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: 'var(--pm-text-faint)' }}>{t('voiceInput.guideSha')}：</span>
              <code
                style={{ cursor: 'pointer', userSelect: 'all' }}
                onClick={() => {
                  void copySha(first.zipSha256)
                }}
              >
                {copied === first.zipSha256 ? `${first.zipSha256}（已复制）` : `${first.zipSha256.slice(0, 16)}…`}
              </code>
            </div>
          )}
        </>
      )}

      <Space size={8} wrap>
        <Button
          size="small"
          type="primary"
          icon={<ImportOutlined />}
          loading={importing}
          onClick={() => {
            void importZip()
          }}
        >
          {importing ? t('voiceInput.guideImporting') : t('voiceInput.guideImport')}
        </Button>
        {first?.helpUrl && (
          <Button size="small" type="link" href={first.helpUrl} target="_blank">
            {t('voiceInput.guideHelp')}
          </Button>
        )}
        {!first?.helpUrl && <span style={{ color: 'var(--pm-text-faint)' }}>{t('voiceInput.guideHelpMissing')}</span>}
        {allowRemove && installed && (
          <Button
            size="small"
            danger
            icon={<ReloadOutlined />}
            onClick={() => {
              const m = list.find((x) => x.installed)
              if (m) removeModel(m.modelId)
            }}
          >
            {t('voiceInput.guideRemove')}
          </Button>
        )}
        {installed && <span style={{ color: 'var(--pm-success, #38a00d)' }}>✓ {t('voiceInput.imported')}</span>}
      </Space>
    </div>
  )
}
