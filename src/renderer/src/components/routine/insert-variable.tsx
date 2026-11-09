// ── 「插入变量」下拉（routine 编辑器与工作流属性面板共用一份）──
// 用户裁定 2026-11-09: 工作流的环节指令要有和任务式对话一样的插入变量能力,
// 「而不是用提示的方式告诉用户有哪些变量」——所以两块编辑面的机制只能有一
// 份实现,否则光标/菜单语义必然漂移。
//
// 两条承重细节:
//  ① 插入落在真实的 caret 上: 读 antd TextArea 底下的原生 <textarea> 的
//     selectionStart/selectionEnd, 写回后 rAF 里恢复光标。
//  ② 恢复光标的顺序是 setSelectionRange → focus: React 的受控写回已经把光
//     标停在值尾, 而 focus() 会滚到光标处——先 focus 会把长文本的视口拖到
//     尾部, 再 setSelectionRange 只挪光标不挪视口(probe-routine-var-insert
//     钉住这条)。
//
// Select 是**动作不是状态**: value 恒 null, 选完立刻显示回占位文案。

import React from 'react'
import { Select } from 'antd'
import type { Input } from 'antd'

export interface InsertVariableOption {
  value: string
  label: string
}

export interface InsertVariableGroup {
  label: string
  options: InsertVariableOption[]
}

/** antd TextArea 的组件 ref 类型——手搓一个更窄的形状不可赋值(TS2322)。
 *  插入要读写真实 selection, 所以消费方都从这里取原生 textarea。 */
export type PromptAreaRef = React.RefObject<React.ComponentRef<typeof Input.TextArea> | null>

/** 把 `{{key}}` 插到 textarea 当前选区(替换选中段, 无选区即光标处), 光标落
 *  在 token 之后。apply 收到的是新文本, 由调用方写回各自的草稿/draft。 */
export function insertTokenAtCaret(ref: PromptAreaRef, value: string, key: string, apply: (next: string) => void): void {
  const token = `{{${key}}}`
  const area = ref.current?.resizableTextArea?.textArea
  const start = area?.selectionStart ?? value.length
  const end = area?.selectionEnd ?? start
  apply(value.slice(0, start) + token + value.slice(end))
  const caret = start + token.length
  requestAnimationFrame(() => {
    if (!area) return
    // Selection BEFORE focus（见文件头 ②）。
    area.setSelectionRange(caret, caret)
    area.focus()
  })
}

export interface InsertVariableSelectProps {
  /** 占位文案（选完回到它——动作而非状态的可见证据）。 */
  placeholder: string
  /** 分组选项；空组会被过滤（没有声明变量时不出「任务变量」组）。 */
  groups: InsertVariableGroup[]
  onInsert: (key: string) => void
  minWidth?: number
}

export function InsertVariableSelect({ placeholder, groups, onInsert, minWidth = 110 }: InsertVariableSelectProps): React.ReactElement {
  return (
    <Select
      size="small"
      style={{ minWidth }}
      // 动作不是状态：见文件头注释。
      value={null}
      placeholder={placeholder}
      onChange={onInsert}
      // 分组标签与本仓的变量说明偏长（「上一阶段交付物 {{prevArtifacts}}」），
      // 菜单跟随内容宽度而不是被 110px 的控件裁成省略号。
      popupMatchSelectWidth={false}
      options={groups.filter((g) => g.options.length > 0).map((g) => ({ label: g.label, options: g.options }))}
    />
  )
}
