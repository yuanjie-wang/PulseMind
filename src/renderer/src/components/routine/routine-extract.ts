// ── Extract a routine draft from a conversation ──
// One chain behind both entries: the routine editor's 从对话提取 picker and the
// chat toolbar's 存为日常任务. Fetches the stored conversation, flattens it to
// 「用户：…／助手：…」 lines and runs the one-shot RoutineExtractionAgent over
// the active profile. Returns null when the conversation holds nothing
// routine-shaped (or nothing at all); toasts and — for the chat entry — the
// navigation to the editor belong to the caller. Renderer-only: it reads
// window.electronAPI, so keep it out of the main process.

// Imported by file, not the barrel: this module loads in tests (the flattener
// is pure), and the barrel would pull every one-shot agent with it.
import { RoutineExtractionAgent } from '../../agent/one-shot-agent/RoutineExtractionAgent'
import type { RoutineDraft } from '../../agent/one-shot-agent/RoutineExtractionAgent'
import type { LlmAdapter } from '../../llm/adapter'

export interface RoutineExtractLlmConfig {
  adapter: LlmAdapter
  apiKey: string
  baseURL: string
  model: string
  /** The model's configured output limit — the one-shot wire budget (thinking
   *  shares it; see LlmConfig.modelMaxTokens). */
  modelMaxTokens?: number
}

export interface ExtractedRoutineDraft extends RoutineDraft {
  sourceConversationId: string
}

/** Flatten stored messages to the transcript the agent reads. The 24k cap is
 *  the agent's own (buildUserMessages), not ours — this stays a pure shape
 *  both callers can unit-test. */
export function conversationToRoutineText(
  messages: Array<{ role: string; contentBlocks?: Array<{ type: string; text?: string }> }> | undefined,
): string {
  const lines: string[] = []
  for (const msg of messages ?? []) {
    const text = (msg.contentBlocks ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
    if (text) lines.push(`${msg.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n\n')
}

export async function extractRoutineFromConversation(
  convId: string,
  llm: RoutineExtractLlmConfig,
  locale: 'zh' | 'en',
): Promise<ExtractedRoutineDraft | null> {
  const conv = await window.electronAPI.getConversation(convId)
  const conversationText = conversationToRoutineText(conv?.messages)
  if (!conversationText.trim()) return null
  const draft = await new RoutineExtractionAgent().execute(
    { conversationText, locale },
    { llmConfig: { apiKey: llm.apiKey, baseURL: llm.baseURL, model: llm.model, adapter: llm.adapter, modelMaxTokens: llm.modelMaxTokens } },
  )
  if (!draft) return null
  return { ...draft, sourceConversationId: convId }
}
