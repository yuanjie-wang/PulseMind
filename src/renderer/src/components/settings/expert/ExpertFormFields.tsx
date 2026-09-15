import React from 'react'
import { Form, Input, Select, type FormInstance } from 'antd'
import { generateExpertId } from '../../../agent/one-shot-agent'
import { useTranslation } from '../../../i18n/useTranslation'

/** A catalog entry the capability selects pick from. */
export interface ExpertRefOption {
  value: string
  label: string
}

export interface ExpertFormFieldsProps {
  form: FormInstance
  /** New expert: the id field is editable and derived from the name. */
  isNew: boolean
  /** 可用技能候选（名称即标识）。 */
  skillOptions: ExpertRefOption[]
  /** 可用连接器候选（MCP 服务 id）。 */
  connectorOptions: ExpertRefOption[]
  /** A field changed by the user — the editor's unsaved-changes flag. */
  onValuesChange?: () => void
}

/** Field labels carry the structure on their own (the section headings are
 *  gone), so they are set a weight above the inputs. */
function boldLabel(text: string): React.ReactNode {
  return <span style={{ fontWeight: 600 }}>{text}</span>
}

/**
 * The expert's identity form. The toolset and the run parameters are
 * deliberately absent — tools, the model and the token budget all follow the
 * global setting. 可用技能 / 可用连接器 are a whitelist: picking items allows
 * exactly those, and picking none allows nothing at all.
 */
export default function ExpertFormFields({
  form,
  isNew,
  skillOptions,
  connectorOptions,
  onValuesChange,
}: ExpertFormFieldsProps): React.ReactElement {
  const { t } = useTranslation()
  // Last id we derived from the name: while the field still holds it, the id
  // keeps following the name. A hand-typed id takes over for good.
  const derivedId = React.useRef('')

  const handleNameChange = (name: string): void => {
    if (!isNew) return
    const current = String(form.getFieldValue('id') || '')
    if (current && current !== derivedId.current) return
    derivedId.current = generateExpertId(name)
    form.setFieldsValue({ id: derivedId.current })
  }

  return (
    <Form form={form} layout="vertical" autoComplete="off" onValuesChange={onValuesChange}>
      <Form.Item
        name="name"
        label={boldLabel(t('expertCenter.name'))}
        rules={[{ required: true, message: t('expertCenter.nameRequired') }]}
      >
        <Input placeholder={t('expertCenter.namePlaceholder')} onChange={(e) => handleNameChange(e.target.value)} />
      </Form.Item>
      {isNew && (
        <Form.Item
          name="id"
          label={boldLabel(t('expertCenter.id'))}
          rules={[{ required: true, message: t('expertCenter.idRequired') }]}
        >
          <Input placeholder={t('expertCenter.idPlaceholder')} />
        </Form.Item>
      )}
      <Form.Item name="description" label={boldLabel(t('expertCenter.description'))}>
        <Input placeholder={t('expertCenter.descriptionPlaceholder')} maxLength={80} />
      </Form.Item>

      <Form.Item name="basePrompt" label={boldLabel(t('expertCenter.persona'))}>
        <Input.TextArea rows={4} placeholder={t('expertCenter.personaPlaceholder')} />
      </Form.Item>
      <Form.Item name="methodology" label={boldLabel(t('expertCenter.methodology'))}>
        <Input.TextArea rows={4} placeholder={t('expertCenter.methodologyPlaceholder')} />
      </Form.Item>
      <Form.Item name="outputSpec" label={boldLabel(t('expertCenter.outputSpec'))}>
        <Input.TextArea rows={4} placeholder={t('expertCenter.outputSpecPlaceholder')} />
      </Form.Item>
      <Form.Item name="constraints" label={boldLabel(t('expertCenter.constraints'))}>
        <Input.TextArea rows={3} placeholder={t('expertCenter.constraintsPlaceholder')} />
      </Form.Item>

      {/* 可用能力白名单：勾了就只允许这几项，一项都不勾就是一个都不许用。 */}
      <Form.Item name="skillNames" label={boldLabel(t('expertCenter.skillNames'))}>
        <Select
          mode="multiple"
          placeholder={skillOptions.length > 0 ? t('expertCenter.skillNamesPlaceholder') : t('expertCenter.skillNamesEmpty')}
          options={skillOptions}
          maxTagCount={6}
          optionFilterProp="label"
        />
      </Form.Item>
      <Form.Item name="mcpServerIds" label={boldLabel(t('expertCenter.mcpServerIds'))}>
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
    </Form>
  )
}
