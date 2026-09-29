/**
 * Stand-in for the `react-syntax-highlighter` bare specifier — wired up by the
 * anchored alias in vite.config.ts (find: /^react-syntax-highlighter$/, so the
 * package's own deep-path style imports are untouched).
 *
 * The package's root entry re-exports the hljs side (Light/LightAsync →
 * highlight.js' full language tables, ~1.54MB + ~190 per-language chunks)
 * next to PrismLight, so ANY root import drags the tables in. Every importer
 * in our graph wants only PrismLight — our own CodeHighlight.tsx, and
 * @ant-design/x's code-highlighter/CodeHighlighter.js + folder/FilePreview.js
 * (the mermaid chain; that 1.54MB chunk was theirs, not ours — our own root
 * import was already tree-shaken out of the entry). The deep path pulls
 * refractor/core alone; highlight.js never enters the bundle (measured
 * 2026-09-29: the index-D3EVwIai hub chunk disappears from out/renderer).
 */
export { default as PrismLight } from 'react-syntax-highlighter/dist/esm/prism-light'
