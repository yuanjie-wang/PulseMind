// ── HTML element edit agent (PLAN-html-element-edit §5, M4) ──
// One-shot agent: given the SELECTED element's own markup plus its ancestor
// chain and a natural-language instruction, returns replacement markup for
// that one element. The boundary is the plan's D9: the model may touch the
// element's own tags/attributes/inline style/text/children — never an
// external stylesheet, never another element, never the whole document.
// `runHtmlAiEdit` is the whole pipeline: context from the store's file text
// (D3), LLM call, strict validation, structural apply (write → reload →
// reselect). Any failure leaves the file untouched and returns the reason.

import { OneShotAgent } from './OneShotAgent'
import type { ExecuteOptions } from './LlmConfig'
import { extractJson } from './json-utils'
import {
  validateAiElementMarkup,
  verifyPatch,
  replaceElement,
} from '../../../../shared/html-edit/patch'
import { resolveElement, elementOuterHtml } from '../../../../shared/html-edit/resolve'
import { useHtmlEditStore, consumeFailure } from '../../stores/htmlEditStore'

export interface HtmlElementEditInput {
  instruction: string
  tag: string
  elementHtml: string
  ancestors: { tag: string; id: string | null; classes: string[] }[]
}

export interface HtmlElementEditOutput {
  /** Replacement outer markup for the element; null when unusable. */
  html: string | null
}

const SYSTEM_PROMPT = `你是网页元素的编辑器。用户在可视化页面里选中了一个 HTML 元素，并给出一句修改要求。
你要输出该元素替换后的完整标记（外层 HTML），规则：
1. 只改这一个元素自身的属性、内联 style、文本或内部子结构；禁止改动外部 CSS、其他元素或整篇文档；
2. 保持元素的标签类型不变（h1 进 h1 出）；
3. 视觉类要求一律用内联 style 表达（如 style="color: red; font-size: 20px"）；
4. 不要添加注释，不要包裹 markdown 代码块，不要输出任何解释；
5. 只输出一个 JSON 对象：{"html": "<tag ...>...</tag>"}
6. 要求无法在不越界的前提下满足时，仍按最接近的合理解释修改元素，不要拒绝。`

export class HtmlElementEditAgent extends OneShotAgent<HtmlElementEditInput, HtmlElementEditOutput> {
  readonly name = 'HtmlElementEditAgent'

  protected buildSystemPrompt(): string {
    return SYSTEM_PROMPT
  }

  protected buildUserMessages(input: HtmlElementEditInput): { role: string; content: string }[] {
    const payload = {
      instruction: input.instruction,
      tag: input.tag,
      ancestors: input.ancestors.map((a) => `${a.tag}${a.id ? `#${a.id}` : ''}${a.classes.map((c) => `.${c}`).join('')}`),
      elementHtml: input.elementHtml,
    }
    return [{ role: 'user', content: JSON.stringify(payload, null, 2) }]
  }

  protected parseResponse(raw: string): HtmlElementEditOutput {
    const parsed = extractJson<{ html?: unknown }>(raw)
    const html = parsed && typeof parsed.html === 'string' ? parsed.html : null
    return { html: html && html.trim() ? html.trim() : null }
  }

  protected getDefaultOutput(): HtmlElementEditOutput {
    return { html: null }
  }
}

export type AiEditResult = { ok: true } | { ok: false; error: string }

/** The full AI-edit pipeline for the panel's 运行 button. */
export async function runHtmlAiEdit(
  path: string,
  instruction: string,
  options: ExecuteOptions,
): Promise<AiEditResult> {
  const store = useHtmlEditStore.getState()
  const session = store.sessions[path]
  const selection = session?.selection
  if (!session || !selection) return { ok: false, error: '没有选中元素' }
  const trimmed = instruction.trim()
  if (!trimmed) return { ok: false, error: '请先描述想怎么改' }

  const resolved = resolveElement(session.fileText, selection.pmPath)
  if (!resolved.ok) return { ok: false, error: resolved.reason }

  store.setAiBusy(path, true, null)
  try {
    const agent = new HtmlElementEditAgent()
    const output = await agent.execute(
      {
        instruction: trimmed,
        tag: selection.tag,
        elementHtml: elementOuterHtml(session.fileText, resolved.location),
        ancestors: resolved.location.ancestors,
      },
      options,
    )
    if (!output.html) {
      store.setAiBusy(path, false, 'AI 没有返回可用的修改')
      return { ok: false, error: 'AI 没有返回可用的修改' }
    }
    const validated = validateAiElementMarkup(output.html, selection.tag)
    if (!validated.ok) {
      store.setAiBusy(path, false, validated.reason)
      return { ok: false, error: validated.reason }
    }
    const applied = await applyAiReplacement(path, validated.html)
    if (!applied) {
      const error = consumeFailure() || '写入失败'
      store.setAiBusy(path, false, error)
      return { ok: false, error }
    }
    store.setAiBusy(path, false)
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    store.setAiBusy(path, false, error)
    return { ok: false, error }
  }
}

/** Structural apply for an AI replacement: span patch → verify → write →
 *  pendingReselect (the reload + reselect happens via the frame's pm:ready). */
async function applyAiReplacement(path: string, newOuter: string): Promise<boolean> {
  const store = useHtmlEditStore.getState()
  const session = store.sessions[path]
  if (!session?.selection) return failAndClear(path, '没有选中元素')
  const selectPath = session.selection.pmPath
  const resolved = resolveElement(session.fileText, selectPath)
  if (!resolved.ok) return failAndClear(path, resolved.reason)
  const patched = replaceElement(session.fileText, resolved.location, newOuter)
  const verified = verifyPatch(patched, { pmPath: selectPath, tag: session.selection.tag })
  if (!verified.ok) return failAndClear(path, verified.reason)
  const res = await window.electronAPI.writeFile({ filePath: path, content: patched })
  if (res && res.success === false) return failAndClear(path, res.error || '写入失败')
  useHtmlEditStore.setState((s) => {
    const cur = s.sessions[path]
    if (!cur) return s
    const undo = [...cur.undo, { before: session.fileText, after: patched, selectPath, scrollY: cur.scrollY }]
    return {
      sessions: {
        ...s.sessions,
        [path]: {
          ...cur,
          fileText: patched,
          undo: undo.slice(-20),
          selection: null,
          pendingReselect: { pmPath: selectPath },
        },
      },
    }
  })
  // The caller reloads the frame (bumpReload); pm:ready then reselects.
  return true
}

function failAndClear(path: string, error: string): false {
  useHtmlEditStore.getState().setAiBusy(path, false, error)
  console.warn(`[html-edit] ${error}`)
  return false
}
