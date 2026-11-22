import { formatAccelerator } from '../../../shared/shortcuts'

/** Alt+V（语音输入）的平台展示词汇：mac `⌥V`（thin space 连排），其余 `Alt+V`。
 *  ⌥ 字形在 Windows 上没人认识——展示面（composer 麦克风 title、设置页 hint）
 *  统一走这里，与快捷键设置页同一 formatter，别再手写 ⌥V 字面量。 */
export function voiceShortcutLabel(): string {
  return formatAccelerator('Alt+V', /mac/i.test(navigator.platform))
}
