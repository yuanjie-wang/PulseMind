import React from 'react'
import { Mermaid } from '@ant-design/x'

interface CodeBlockProps {
  children?: React.ReactNode
  block?: boolean
  lang?: string
  className?: string
  [key: string]: unknown
}

export function CodeBlock({
  children,
  block,
  lang,
  className
}: CodeBlockProps): React.ReactNode {
  if (block && lang === 'mermaid') {
    let code = ''
    if (typeof children === 'string') {
      code = children
    } else if (Array.isArray(children)) {
      code = children.map((c) => (typeof c === 'string' ? c : '')).join('')
    }
    code = code.trim()
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
  return <code className={className}>{children}</code>
}
