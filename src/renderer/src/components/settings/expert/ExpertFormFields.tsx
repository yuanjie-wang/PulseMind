import React from 'react'
import { Form, Input, Select, type FormInstance } from 'antd'
import type { KnowledgeOption } from '../../../agent/one-shot-agent'
import { generateExpertId } from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'

/** A catalog entry the reference selects pick from. */
export interface ExpertRefOption {
  value: string
  label: string
}

export interface ExpertFormFieldsProps {
  form: FormInstance
  /** New expert: the id field is editable and derived from the name. */
  isNew: boolean
  knowledgeFiles: KnowledgeOption[]
  /** 常用技能（引用关系，注入指令，不是权限白名单）。 */
  skillOptions: ExpertRefOption[]
  /** 常用连接器（同上）。 */
  connectorOptions: ExpertRefOption[]
  /** A field changed by the user — the editor's unsaved-changes flag. */
  onValuesChange?: () => void
}

/** A titled form section — the blocks the editor's middle column is made of. */
export function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#999', margin: '16px 0 10px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

/**
 * The expert's identity form. Capability and run parameters are deliberately
 * absent: tools, connectors, skills, the model and the token budget all follow
 * the global setting. 引用关系 (常用技能 / 常用连接器) is not a capability
 * setting either — it only names the skills and connectors the expert should
 * reach for by default, and is injected into its instructions.
 */
export default function ExpertFormFields({
  form,
  isNew,
  knowledgeFiles,
  skillOptions,
  connectorOptions,
  onValuesChange,
}: ExpertFormFieldsProps): React.ReactElement {
  const { t } = useTranslation()
  // Last id we derived from the name: while the field still holds it, the id
  // keeps following the name. A hand-typed id takes over for good.
  const derivedId = React.useRef('')

  const knowledgeOptions = knowledgeFiles.map((f) => ({ value: f.id, label: f.title }))

  const handleNameChange = (name: string): void => {
    if (!isNew) return
    const current = String(form.getFieldValue('id') || '')
    if (current && current !== derivedId.current) return
    derivedId.current = generateExpertId(name)
    form.setFieldsValue({ id: derivedId.current })
  }

  return (
    <Form form={form} layout="vertical" autoComplete="off" onValuesChange={onValuesChange}>
      <FormSection title={t('expertCenter.sectionBasic')}>
        <Form.Item
          name="name"
          label={t('expertCenter.name')}
          rules={[{ required: true, message: t('expertCenter.nameRequired') }]}
        >
          <Input placeholder={t('expertCenter.namePlaceholder')} onChange={(e) => handleNameChange(e.target.value)} />
        </Form.Item>
        {isNew && (
          <Form.Item name="id" label={t('expertCenter.id')} rules={[{ required: true, message: t('expertCenter.idRequired') }]}>
            <Input placeholder={t('expertCenter.idPlaceholder')} />
          </Form.Item>
        )}
        <Form.Item name="description" label={t('expertCenter.description')}>
          <Input placeholder={t('expertCenter.descriptionPlaceholder')} maxLength={80} />
        </Form.Item>
      </FormSection>

      <FormSection title={t('expertCenter.sectionPersona')}>
        <Form.Item name="basePrompt" label={t('expertCenter.persona')}>
          <Input.TextArea rows={4} placeholder={t('expertCenter.personaPlaceholder')} />
        </Form.Item>
        <Form.Item name="methodology" label={t('expertCenter.methodology')}>
          <Input.TextArea rows={4} placeholder={t('expertCenter.methodologyPlaceholder')} />
        </Form.Item>
        <Form.Item name="outputSpec" label={t('expertCenter.outputSpec')}>
          <Input.TextArea rows={4} placeholder={t('expertCenter.outputSpecPlaceholder')} />
        </Form.Item>
        <Form.Item name="constraints" label={t('expertCenter.constraints')}>
          <Input.TextArea rows={3} placeholder={t('expertCenter.constraintsPlaceholder')} />
        </Form.Item>
      </FormSection>

      <FormSection title={t('expertCenter.sectionBindings')}>
        <Form.Item name="knowledgeFileIds" label={t('expertCenter.knowledgeFiles')}>
          <Select
            mode="multiple"
            placeholder={knowledgeFiles.length > 0 ? t('expertCenter.knowledgePlaceholder') : t('expertCenter.knowledgeEmpty')}
            options={knowledgeOptions}
            maxTagCount={6}
            optionFilterProp="label"
          />
        </Form.Item>
      </FormSection>

      <FormSection title={t('expertCenter.sectionReferences')}>
        <Form.Item name="skillNames" label={t('expertCenter.skillNames')}>
          <Select
            mode="multiple"
            placeholder={skillOptions.length > 0 ? t('expertCenter.skillNamesPlaceholder') : t('expertCenter.skillNamesEmpty')}
            options={skillOptions}
            maxTagCount={6}
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item name="mcpServerIds" label={t('expertCenter.mcpServerIds')}>
          <Select
            mode="multiple"
            placeholder={
              connectorOptions.length > 0 ? t('expertCenter.mcpServerIdsPlaceholder') : t('expertCenter.mcpServerIdsEmpty')
            }
            options={connectorOptions}
            maxTagCount={6}
            optionFilterProp="label"
          />
        </Form.Item>
      </FormSection>
    </Form>
  )
}
