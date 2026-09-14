import React from 'react'
import { Mermaid } from '@ant-design/x'
import { CodeHighlight, resolveCodeLang } from '../common/CodeHighlight'

interface CodeBlockProps {
  children?: React.ReactNode
  block?: boolean
  lang?: string
  className?: string
  [key: string]: unknown
}

/** Flatten a code element's children into its source text. */
function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/** The `code` handler shared by every XMarkdown site in the chat. Block code
 *  renders through the shared Prism highlighter (mermaid keeps its diagram
 *  renderer); inline code and unknown languages stay as plain `<code>`. */
export function CodeBlock({
  children,
  block,
  lang,
  className
}: CodeBlockProps): React.ReactNode {
  const text = childrenToText(children)

  if (block && lang === 'mermaid') {
    const code = text.trim()
    if (code) {
      const sanitized = code.replace(
        /\[([^\]]*)\]/g,
        (_match, inner) => `[${inner.replace(/"/g, '“')}]`
      )
      return <Mermaid>{sanitized}</Mermaid>
    }
    console.warn('[Mermaid] empty content')
    return <code className={className}>{children}</code>
  }

  if (block) {
    const langId = lang ? resolveCodeLang(lang) : null
    if (langId) return <CodeHighlight code={text} lang={langId} fontSize={14} />
  }

  return <code className={className}>{children}</code>
}
