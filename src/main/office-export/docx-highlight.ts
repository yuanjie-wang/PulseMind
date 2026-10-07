// ── docx 代码块语法高亮（PLAN-docx-native-styles M7）──
// highlight.js/lib/core + 显式语言注册：运行时面只含常用语言，未注册语言回落
// 纯文本（与今天一致，不算降级）。色板取 oneLight——聊天侧 Prism 浅色主题的
// 同源视觉语言；hljs 输出的是 HTML 片段，这里解析回 (text, scope) 段交给
// 生成器落 TextRun 颜色，灰底块/等宽字体/行边框的手法全不动。

import hljs from 'highlight.js/lib/core'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def)

export interface CodeSegment {
  text: string
  color?: string
}

// oneLight 的映射规则按序匹配（title.class 先于 title）；未命中的 scope 不
// 上色——正文墨色即默认。
const COLOR_RULES: Array<[RegExp, string]> = [
  [/^comment/, 'A0A1A7'],
  [/^quote/, 'A0A1A7'],
  [/^title\.class/, 'C18401'],
  [/^title/, '4078F2'],
  [/^class/, 'C18401'],
  [/^built_in/, 'C18401'],
  [/^type/, 'C18401'],
  [/^keyword/, 'A626A4'],
  [/^selector-tag/, 'A626A4'],
  [/^doctag/, 'A626A4'],
  [/^formula/, 'A626A4'],
  [/^string/, '50A14F'],
  [/^regexp/, '50A14F'],
  [/^addition/, '50A14F'],
  [/^char/, '50A14F'],
  [/^number/, '986801'],
  [/^literal/, '986801'],
  [/^attr/, '986801'],
  [/^variable/, 'E45649'],
  [/^template-variable/, 'E45649'],
  [/^property/, 'E45649'],
  [/^deletion/, 'E45649'],
  [/^name/, 'E45649'],
  [/^tag/, 'E45649'],
  [/^params/, 'E45649'],
  [/^meta/, '4078F2'],
  [/^selector-id/, '4078F2'],
]

function scopeColor(classes: string[]): string | undefined {
  for (const cls of classes) {
    const name = cls.replace(/^hljs-/, '')
    if (!name) continue
    for (const [re, color] of COLOR_RULES) if (re.test(name)) return color
  }
  return undefined
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}
const decodeEntities = (s: string): string => s.replace(/&(?:lt|gt|quot|#39|apos|nbsp|amp);/g, (m) => (m === '&amp;' ? '&' : ENTITIES[m]))

/** 代码文本 → 逐行着色段。语言未注册（或高亮异常）返回 null，调用方走纯文
 *  本路径；行数与 `code.split('\n')`（去掉末尾空行后）严格一致——生成器按行
 *  画灰底段落，行数错位会错版，宁可不用。 */
export function highlightToLines(code: string, lang: string): CodeSegment[][] | null {
  if (!code.trim() || !hljs.getLanguage(lang)) return null
  let html: string
  try {
    html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
  // 解析 hljs 的 HTML 片段：只有 <span class="…"> / </span> / 文本三种形态。
  // 嵌套 span 取最内层的 class 栈顶定色。
  const segments: CodeSegment[] = []
  const stack: string[][] = []
  let text = ''
  const flush = (): void => {
    if (!text) return
    const color = stack.length ? scopeColor(stack[stack.length - 1]) : undefined
    segments.push({ text: decodeEntities(text), ...(color ? { color } : {}) })
    text = ''
  }
  let i = 0
  while (i < html.length) {
    if (html.startsWith('<span class="', i)) {
      flush()
      const end = html.indexOf('">', i)
      if (end < 0) return null // 异常形态宁可放弃高亮，不出错版字节
      stack.push(html.slice(i + 13, end).split(/\s+/))
      i = end + 2
    } else if (html.startsWith('</span>', i)) {
      flush()
      stack.pop()
      i += 7
    } else {
      text += html[i]
      i++
    }
  }
  flush()
  const lines: CodeSegment[][] = [[]]
  for (const seg of segments) {
    const parts = seg.text.split('\n')
    parts.forEach((part, j) => {
      if (j > 0) lines.push([])
      if (part) lines[lines.length - 1].push({ text: part, ...(seg.color ? { color: seg.color } : {}) })
    })
  }
  if (code.endsWith('\n') && lines.length > 1) lines.pop()
  return lines
}
