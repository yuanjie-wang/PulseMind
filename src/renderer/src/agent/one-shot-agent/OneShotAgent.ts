import { estimateTextTokens } from '../engine/context-estimate'
import type { ExecuteOptions } from './LlmConfig'

/**
 * Enforce the scenario's max-output-length requirement on the FINAL content
 * (ExecuteOptions.maxOutputTokens). Deliberately upstream-independent: the
 * wire max_tokens is LlmConfig.modelMaxTokens and thinking is not suppressed,
 * so neither can make content longer — this only bounds what the consumer
 * receives. The estimate is the shared CJK-aware heuristic; the cut is a
 * plain prefix — a JSON consumer over its cap fails its own parse into the
 * default-output path, which is the honest degradation for an output that
 * violated its scenario's requirement.
 */
export function enforceMaxOutputTokens(raw: string, maxOutputTokens?: number): string {
  if (!maxOutputTokens || !raw) return raw
  if (estimateTextTokens(raw) <= maxOutputTokens) return raw
  let lo = 0
  let hi = raw.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTextTokens(raw.slice(0, mid)) <= maxOutputTokens) lo = mid
    else hi = mid - 1
  }
  return raw.slice(0, lo)
}

/**
 * 裁定五：prompt 层的弱兜底——部分混合思考模型（Qwen3、DeepSeek 混合版等）
 * 会对「不要思考」类指令生效、直接跳过思考阶段。这是请求参数之外的第二层
 * 缓解，不承诺任何网关行为（关思考的参数形状跨模型家族不统一，见
 * LlmConfig.modelMaxTokens 的注释）；wire 预算仍装得下 reasoning，模型不听
 * 这句话也不损失内容。中英双语覆盖中英文 system prompt 的家族。
 */
export const ONE_SHOT_NO_THINKING_DIRECTIVE =
  '直接输出最终结果，不要思考，不要输出思考过程。Output the final result directly — do not think or reason step by step, and do not emit any thinking process.'

/** Append the directive to a one-shot system prompt (idempotent-shape: the
 *  directive is a fixed suffix, never interpolated into the caller's text). */
export function withNoThinkingDirective(systemPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${ONE_SHOT_NO_THINKING_DIRECTIVE}` : ONE_SHOT_NO_THINKING_DIRECTIVE
}

export abstract class OneShotAgent<TInput, TOutput> {
  abstract readonly name: string

  protected abstract buildSystemPrompt(input: TInput): string

  protected abstract buildUserMessages(input: TInput): { role: string; content: string }[]

  protected abstract parseResponse(raw: string, input: TInput): TOutput

  protected abstract getDefaultOutput(input: TInput): TOutput

  async execute(input: TInput, options: ExecuteOptions): Promise<TOutput> {
    // Wire budget = the model's own output limit, and NOTHING else — the
    // scenario's maxOutputTokens is enforced on the final content below and
    // never touches the wire (thinking shares the wire budget; see
    // LlmConfig.modelMaxTokens). The 4096 fallback only serves configs that
    // were never plumbed with the model's limit.
    const wireMaxTokens = options.llmConfig.modelMaxTokens ?? 4096
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await options.llmConfig.adapter.callNonStreaming(
          options.llmConfig.apiKey,
          options.llmConfig.baseURL,
          options.llmConfig.model,
          withNoThinkingDirective(this.buildSystemPrompt(input)),
          this.buildUserMessages(input),
          wireMaxTokens,
          options.onUsage,
          options.onFinishReason,
        )
        if (!raw) {
          if (attempt === 0) {
            console.warn(`[${this.name}] LLM returned null, retrying (1/1)...`)
            continue
          }
          console.warn(`[${this.name}] LLM returned null after retry, using default`)
          return this.getDefaultOutput(input)
        }
        return this.parseResponse(enforceMaxOutputTokens(raw, options.maxOutputTokens), input)
      } catch (err) {
        if (attempt === 0) {
          console.warn(`[${this.name}] execution failed, retrying (1/1):`, err)
          continue
        }
        console.warn(`[${this.name}] execution failed after retry:`, err)
        return this.getDefaultOutput(input)
      }
    }
    return this.getDefaultOutput(input)
  }
}
