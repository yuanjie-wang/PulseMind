// highlight.js ships typings for its main entry and 'lib/languages/*' but not
// for the 'lib/core' subpath this module imports (core + explicit language
// registration keeps the runtime surface small) — declare the missing piece.
declare module 'highlight.js/lib/core' {
  import type { HLJSApi } from 'highlight.js'
  const hljs: HLJSApi
  export default hljs
}
