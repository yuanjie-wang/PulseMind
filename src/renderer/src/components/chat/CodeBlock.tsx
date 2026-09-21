import React, { Suspense } from 'react'
import { CodeHighlight, resolveCodeLang } from '../common/CodeHighlight'

// The diagram renderer, lazily: @ant-design/x's Mermaid module imports mermaid
// at its top level (~430 KB with js-yaml), and a static import here put that in
// the first-paint chunk for every conversation whether or not it contains a
// diagram. The deep path is the component module itself — the package ships no
// `exports` map, and going through the barrel (`import { Mermaid } from
// '@ant-design/x'`) is exactly what dragged mermaid in.
const LazyMermaid = React.lazy(() => import('@ant-design/x/es/mermaid/Mermaid'))

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
      // The fallback is the plain code element this block already returns for
      // an unknown language: mermaid itself paints the source before the SVG
      // is ready, so code-then-diagram is the shape the user sees either way.
      return (
        <Suspense fallback={<code className={className}>{children}</code>}>
          <LazyMermaid>{sanitized}</LazyMermaid>
        </Suspense>
      )
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
