/**
 * Studio composer: the light variant of the chat composer — same Sender shell
 * and chrome (chat/Composer), no attachments, model picker or context ring.
 */
import React, { useState } from 'react'
import { Composer, useInputHistory } from '../chat/Composer'

export interface StudioComposerProps {
  onSend: (text: string) => void
  onCancel: () => void
  isRequesting: boolean
  /** Blocks input (no API key configured). */
  disabled?: boolean
  /** Placeholder switches to "iterate" copy once the tool exists. */
  hasContent: boolean
}

export function StudioComposer({ onSend, onCancel, isRequesting, disabled, hasContent }: StudioComposerProps): React.ReactElement {
  const [value, setValue] = useState('')
  const history = useInputHistory()

  const submit = (raw: string): void => {
    const text = raw.trim()
    if (!text) return
    history.push(text)
    setValue('')
    onSend(text)
  }

  return (
    <Composer
      layout="inline"
      maxRows={6}
      value={value}
      onChange={setValue}
      onSubmit={submit}
      onCancel={onCancel}
      isRequesting={isRequesting}
      disabled={disabled}
      autoFocus
      placeholder={
        disabled
          ? '请先在设置中配置 API Key'
          : hasContent
          ? '想改点什么？例如：加一个请求历史列表'
          : '描述你想要的工具…'
      }
      onKeyDown={(e) => history.onKeyDown(e, value, setValue)}
    />
  )
}
