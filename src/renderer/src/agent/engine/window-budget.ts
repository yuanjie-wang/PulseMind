/**
 * The window a REQUEST may actually fill — the input side only.
 *
 * A provider's context window is shared between input and output: a request
 * that sends N input tokens also asks for up to `max_tokens` output, and the
 * provider rejects the pair once N + max_tokens exceeds the window. The epoch
 * predicate (`price > T`) divides by this input-side window, so using the raw
 * total is off by exactly the output reservation. At a 200K window with a 32K
 * ask, a cold-start trigger computed on the TOTAL window fires at 0.85 × 200K
 * = 170K; that request then asks for 32K of output → 202K, a guaranteed 400 —
 * and one that gets WORSE as max_tokens grows, the opposite of what a bigger
 * output allowance should mean. Against `effectiveInputWindow` (168K) the same
 * trigger sits at 142.8K and the whole reserve stays intact. The retired
 * 0.9×/0.6× fit gates belong to the pre-epoch four-gate pipeline (2026-11-21).
 *
 * `opts.contextLength` therefore keeps meaning "the provider's total window":
 * that is what stream-runner's re-aim parses out of a provider error, and what
 * the context ring and the gauge show the user (方案 A). This module is the one
 * place that converts it into the budget the predicate may spend, so the
 * reduction cannot drift between its consumers: AgentEngine reaches it through
 * one private `inputWindow` getter and one direct call (request-build, which
 * must read the caller's `opts` rather than `this.opts`).
 */

/** Assumed output ask when the caller cannot say what the model's limit is.
 *  Mirrors the main process's options assembly — `profile.maxTokens ?? 32768`
 *  (session-manager.ts, both call sites) — NOT ZCode's 32_000: a profile-backed
 *  session never hands the engine "unknown", so callers that read profiles on
 *  their own (the context ring's resolveMaxTokens) must fall back to the SAME
 *  number or the tick drifts off the engine's real boundary by the difference
 *  (768 tokens was a real review finding, 2026-11-17). */
export const DEFAULT_OUTPUT_RESERVE = 32_768

/** 输出侧在 wire 上的加宽倍数。思考型网关把 reasoning 记在 `max_tokens`
 *  里面，按配置值原样要会把可见回复截断，所以 buildRequest 一直发
 *  `配置值 × 1.5`（AgentEngine.buildRequest）。这个数也是钳制的对象：见
 *  `wireMaxTokens`。 */
export const OUTPUT_HEADROOM = 1.5

/** 钳制后仍不给出低于这个数的输出额度：再小就等于保证一个被截断的答复，
 *  不如让它 400 走 overflow 救援——那条路会真的把输入切短，这才是病根。 */
const MIN_VISIBLE_OUTPUT = 1024

/**
 * 一次请求实际可以**要**的 `max_tokens`：配置值 × 思考余量，再按本次请求的
 * 输入价钳到窗口以内。
 *
 * 为什么必须钳：provider 校验的是 `input + max_tokens ≤ 窗口`，用的是**请求里
 * 写的**那个 max_tokens，跟它最后实际输出多长无关。而 `effectiveInputWindow`
 * 只按 `opts.maxTokens`（×1）留 reserve，wire 却要 `×1.5` —— 缺口 0.5×。宽
 * 窗口下这笔缺口被切深（`Δ` 最浅也有 0.15b）吸收了，窗口一小就露出来：50K 窗
 * 口配 32K 上限时，切到底的请求仍然要 49152 输出，单这一项就占窗口 98%，每条
 * 请求都发不出去（2026-11-22 真机实测）。
 *
 * 钳制读的是本版请求**已经算出来的**输入价，所以它天然跟着切割走：切得越深，
 * 剩下的输出额度越大。窗口宽裕时它算出来的就是原来那个数（150K/32K：可用输出
 * 68K，远大于 49152），请求与改动前完全一致。
 *
 * `inputTokens` 缺省/非法 = 不知道这版请求多大，退回不加钳的旧行为（测试桩、
 * 非请求路径的调用方）。
 */
export function wireMaxTokens(maxTokens: number | undefined, contextLength: number, inputTokens?: number): number {
  const configured = typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_OUTPUT_RESERVE
  const asked = Math.floor(configured * OUTPUT_HEADROOM)
  const window = typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0 ? contextLength : 0
  if (!window) return asked
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) return asked
  const room = Math.floor(window - inputTokens)
  if (room < MIN_VISIBLE_OUTPUT) return asked
  return Math.min(asked, room)
}

/**
 * The input-side budget for a total window of `contextLength`.
 *
 * THE RESERVE IS A PLANNING NUMBER; THE CLAMP IS THE GUARANTEE. 这里按
 * `opts.maxTokens`（配置值，×1）预留，它决定「还能装多少历史」；wire 上真正要
 * 的输出额度由 `wireMaxTokens()` 按本版输入价钳出来，它才是
 * `input + max_tokens ≤ 窗口` 的保证。两者分工，而不是同一个数抄两遍。
 *
 * 历史（别再写回去）：这段注释曾断言「PulseMind 不写 max_tokens（已核实）」，
 * 那是错的 —— `AgentEngine.buildRequest` 一直在写 `maxTokens × 1.5`，而预留只
 * 按 ×1 算。0.5× 的缺口在 50K/32K 这种配置下会把每条请求都打成 400
 * （2026-11-22 实测：切到 17500 的请求仍要 49152 输出）。
 *
 * 剩下的是一条比例守卫：预留不得超过窗口的一半。过半就没有输入预算可言 ——
 * 模型没法既读完提示又答题 —— 而 0 预算比很小的预算更糟，因为每个闸门都拿它
 * 做除数（`tokens < 0 * ratio` 永不成立，回合后的 prewarm 会每一轮都点火）。
 */
export function effectiveInputWindow(contextLength: number, maxTokens?: number): number {
  const asked = typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_OUTPUT_RESERVE
  const reserve = Math.min(asked, Math.floor(contextLength / 2))
  return Math.max(0, contextLength - reserve)
}
