import React, { Suspense } from 'react'
import { CodeHighlight, resolveCodeLang } from '../common/CodeHighlight'
import { HtmlArtifactCard, isHtmlFenceLang } from './HtmlArtifactCard'
import { useThemeMode } from '../../theme/mode'
import type { MermaidConfig } from 'mermaid'

// The diagram renderer, lazily: @ant-design/x's Mermaid module imports mermaid
// at its top level (~430 KB with js-yaml), and a static import here put that in
// the first-paint chunk for every conversation whether or not it contains a
// diagram. The deep path is the component module itself — the package ships no
// `exports` map, and going through the barrel (`import { Mermaid } from
// '@ant-design/x'`) is exactly what dragged mermaid in.
const LazyMermaid = React.lazy(() => import('@ant-design/x/es/mermaid/Mermaid'))

// Mermaid runs on its own theme, chosen in JS like Prism's tokens above (a mode
// flip must also re-render the diagram): without it the component initializes
// `theme: 'default'` forever, and in dark mode the x-markdown dark theme's
// `.x-markdown-dark p` (white, and it legitimately reaches the <p> inside the
// SVG's foreignObject labels — mermaid's own rules only style span/text) paints
// white text on the default theme's light #ECECFF nodes. Module constants so a
// re-render hands the component a stable config identity.
const MERMAID_CONFIG: Record<'light' | 'dark', MermaidConfig> = {
  light: { theme: 'default' },
  dark: { theme: 'dark' },
}

interface CodeBlockProps {
  children?: React.ReactNode
  block?: boolean
  lang?: string
  className?: string
  /** x-markdown's fence state ('loading' while the fence is unterminated).
   *  Only the html branch consumes it: the card live-previews the partial
   *  fragment, everything else renders identically either way. */
  streamStatus?: 'loading' | 'done'
  [key: string]: unknown
}

/** Flatten a code element's children into its source text. */
function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

/**
 * The `code` handler shared by every XMarkdown site in the chat. Block code
 * renders through the shared Prism highlighter (mermaid keeps its diagram
 * renderer, html keeps its artifact card); inline code and unknown languages
 * stay as plain `<code>`. */
export function CodeBlock({ children, block, lang, className, streamStatus }: CodeBlockProps): React.ReactNode {
  const mode = useThemeMode()
  const text = childrenToText(children)

  if (block && lang === 'mermaid') {
    const code = text.trim()
    if (code) {
      const sanitized = code.replace(/\[([^\]]*)\]/g, (_match, inner) => `[${inner.replace(/"/g, '“')}]`)
      // The fallback is the plain code element this block already returns for
      // an unknown language: mermaid itself paints the source before the SVG
      // is ready, so code-then-diagram is the shape the user sees either way.
      return (
        <Suspense fallback={<code className={className}>{children}</code>}>
          <LazyMermaid config={MERMAID_CONFIG[mode]}>{sanitized}</LazyMermaid>
        </Suspense>
      )
    }
    console.warn('[Mermaid] empty content')
    return <code className={className}>{children}</code>
  }

  // The html artifact card sits BEFORE the highlighter on purpose: a ```html
  // fence is a deliverable to preview, not code to read (the card carries its
  // own source tab). An empty fence still falls through to the plain code.
  if (block && lang && isHtmlFenceLang(lang)) {
    const code = text.trim()
    if (code) return <HtmlArtifactCard code={code} streaming={streamStatus === 'loading'} />
  }

  if (block) {
    const langId = lang ? resolveCodeLang(lang) : null
    if (langId) return <CodeHighlight code={text} lang={langId} fontSize={14} />
  }

  return <code className={className}>{children}</code>
}
