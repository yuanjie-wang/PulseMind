// ── Prism language id → CodeMirror grammar (2026-10-31 CM editor batch) ──
//
// The preview pane's edit mode speaks the SAME language ids as the view mode:
// `resolveCodeLang` (shared/preview/code-lang.ts) yields a Prism id, and this
// module turns that id into a CM6 grammar. Keeping the mapping keyed by the
// Prism id — not by file extension — means the two halves can never disagree
// about what a file is: whatever the view highlights, the editor parses.
//
// Coverage contract (pinned by tests/codemirror-editor.test.ts): EVERY id
// resolveCodeLang can return has an entry here, `null` included (null = no
// grammar, still a fully editable editor — the PlainCode honest-degradation
// semantics carried over). Markup is the one coarse id: html/htm/xml/svg all
// resolve to `markup` upstream (refractor registers them the same way), so
// the HTML grammar covers all four — the same approximation the view mode
// already makes.

import { StreamLanguage, type LanguageSupport } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { toml } from '@codemirror/legacy-modes/mode/toml'

export type CmGrammar = LanguageSupport | StreamLanguage<unknown> | null

/** Grammar factories, called lazily so a file open pays only for its own
 *  grammar's construction (module import stays cheap for the lazy chunk). */
const GRAMMAR_FACTORIES: Record<string, () => CmGrammar> = {
  markdown: () => markdown(),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  python: () => python(),
  bash: () => StreamLanguage.define(shell),
  yaml: () => yaml(),
  markup: () => html(),
  css: () => css(),
  sql: () => sql(),
  go: () => go(),
  rust: () => rust(),
  java: () => java(),
  ruby: () => StreamLanguage.define(ruby),
  php: () => php(),
  c: () => cpp(),
  cpp: () => cpp(),
  toml: () => StreamLanguage.define(toml)
}

/** Every Prism id this table knows about — the coverage universe the wiring
 *  test iterates against LANG_LOOKUP's value set. */
export const CM_GRAMMAR_IDS = Object.keys(GRAMMAR_FACTORIES)

/** Map a Prism language id (resolveCodeLang's output) to a CM6 grammar.
 *  Unknown id → null (editable, unhighlighted — same honest gap as
 *  PlainCode in the view half). */
export function cmLangFor(prismLangId: string): CmGrammar {
  const make = GRAMMAR_FACTORIES[prismLangId]
  return make ? make() : null
}
