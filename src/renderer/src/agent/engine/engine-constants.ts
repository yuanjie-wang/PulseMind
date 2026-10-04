// ── Engine tuning constants (moved off AgentEngine statics 0.4.1) ──
// The engine/* strategy modules need these values but must not depend on the
// concrete AgentEngine class; plain consts break that edge. Nothing outside
// agent/engine/ referenced the old statics.

// ── Client-side mirror sync coalescing ────────────────────────────────
// NOTIFY_COALESCE_MS bounds the engine→mirror leg; SYNC_COALESCE_MS applies
// the same cadence to the mirror→React leg (useConversationEngine /
// useHostedAgentSession). The mirror replaces every slice BY REFERENCE, so
// the client can also skip slices an event never touched — without both, a
// streaming_blocks-only tick rebuilds the messages/plan identity and every
// [messages, …] useMemo downstream (turnRows' "not re-paid per token"
// contract, the ring's estimate) re-pays per tick anyway.
export const SYNC_COALESCE_MS = 80

// ── Stream idle-timeout retry ──────────────────────────────────────────
// The main-process proxy aborts streams that stay idle for 60s (long silent
// thinking, network blips). Instead of failing, re-issue the request a few
// times — the messages array is untouched until onStreamComplete, so a retry
// simply re-generates from scratch.
export const MAX_STREAM_IDLE_RETRIES = 2
export const STREAM_IDLE_TIMEOUT_MARKERS = ['闲置超时', 'Stream idle timeout', 'stream done watchdog']

// ── Stream-done watchdog ───────────────────────────────────────────────
// done/error are emitted synchronously inside performLlmStream before its
// promise resolves, so a still-pending streamDonePromise after that resolve
// means the resolver was dropped somewhere below — the exact shape that
// parked two plan sub-agents of conv_20260930091135 mid-run for hours (no
// error, no settlement, no socket). Bounded wait, then a loud retryable
// error instead of an eternal await.
export const STREAM_DONE_WATCHDOG_MS = 30_000
export const STREAM_DONE_WATCHDOG_ERROR = 'stream done watchdog: 请求已结束但 done/error 事件未到达（疑似内部挂起），已按闲置超时处理'

// ── Thinking-only round retry ──────────────────────────────────────────
// A reasoning model can end a round with ONLY a thinking block — no text, no
// tool calls (conv_20260927170026: deepseek-v4.1-flash wrote 「我停止思考，正式
// 输出」 then looped 「好。发。（写）完成。」 ~770 times, burned 14k output
// tokens and closed with nothing). The engine re-issues ONCE per turn — a
// fresh sampling chance, bounded so the 2026-09-20 content-less-reissue loop
// can never return. A second consecutive degenerate round ends the turn as an
// explicit error instead of the old silent close.
export const MAX_THINKING_ONLY_RETRIES = 1

// ── Tool parameter size limits ──────────────────────────────────────────
// Prevents the LLM from passing overly large arguments (e.g. write content,
// edit diffs) that would waste tokens or cause memory issues.
export const TOOL_PARAM_LIMITS: Record<string, Record<string, number>> = {
  write: { content: 500_000 },
  edit: { diff: 200_000, new_str: 200_000 },
  spawn_agent: { task: 200_000 },
  // install carries a whole SKILL.md inline (skills are KB-scale; 100KB is
  // already far past any sane skill text).
  install: { content: 100_000 },
  // PLAN-office-editing: the ops array rides the tool call into the engine.
  // office_edit is the three editors merged (2026-10-04) — one cap for the
  // union, the same number each of them enforced.
  office_edit: { ops: 120_000 },
  // The page tools go over the wire to another process and into a live page;
  // a runaway string here is an in-page eval, not just a big prompt.
  page_execute_js: { script: 50_000 },
  page_input: { text: 100_000 },
}
export const MAX_TOOL_INPUT_JSON_BYTES = 1_000_000 // 1 MB safety net for any tool

// ── User input cap ──────────────────────────────────────────────────────
// User ruling 2026-09-30: 「给输入框一个4k的上限」. 4000 chars ≈ 4000 tokens in
// the worst case (all CJK at the estimator's ~1 token/char) — a huge paste
// used to ride the conversation forever (lightCompact only drops tool cycles;
// a pure-text user message is only cut by hardTruncate past the 0.9× window
// line). Enforced at two depths: the desktop composer's onChange wrapper
// (feedback: the near-limit counter), and prepareTurn as the protocol-level
// backstop for clients without the UI clamp — staged rows restored from old
// drafts, the extension panel, hosted sessions. This lives in engine-constants
// (not Composer.tsx) because AgentEngine is de-facto shared code and must not
// import a component module. Attachments stay out of this budget: they ride
// as [file:path] refs, and content only enters via read's own
// MAX_READ_RESULT_TOKENS.
export const MAX_USER_INPUT_CHARS = 4_000

// ── Turn-end memory salvage (PLAN-memory-extraction-dedup) ──────────────
// In-loop extraction is GONE (scheduleMemoryExtraction deleted — the loop no
// longer spends LLM calls on memory). The only salvage path runs at TURN END,
// capped per session, and only when context pressure puts old tool pairs at
// risk of being compacted away before the turn-end extractAndSaveAll sees them.
export const MEM_SALVAGE_MAX_PER_SESSION = 3
export const MEM_SALVAGE_CONTEXT_RATIO = 0.9

// ── Tool-result / spawn-envelope context guardrails ─────────────────────
// Per-tool-result token budget enforced by the engine's addToolResult (errors
// pass whole; anything over is head+tail truncated with the full text offloaded
// to ~/.pulsemind/tmp/trunc/ for the model to read back). Lives here — not on
// AgentEngine — because spawn-tool sizes the batch-split envelope budget from
// it, and importing AgentEngine from an executor would close a cycle
// (AgentEngine → tool-executors → executors/spawn-tool → AgentEngine).
export const MAX_TOOL_RESULT_TOKENS = 4_000

// read's dedicated budget (every read branch passes it as addToolResult's
// maxTokens): read pages are line-bounded (500/call) but NOT byte-bounded, and
// reading a file IS the task — so read skips the 4K default for this higher
// line, where every normal page lands whole. It only bites pathological
// shapes: files with very long lines (minified bundles, single-line JSON,
// base64) turn one 500-line page into up to ~1MB ≈ hundreds of K tokens,
// which would exceed the entire window in a single result; past the line the
// standard head+tail truncation + tmp/trunc/ offload applies, same as any
// other tool result.
export const MAX_READ_RESULT_TOKENS = 30_000

// spawn_agent envelopes share ONE budget per assistant round: 11 parallel
// experts each returning up to 4k tokens would append ~44k tokens in a single
// collector message — which sits in every compaction layer's protection
// window, so nothing can relieve it before the next request goes out. That
// message is the shape behind the 0.4.1 "ring says 35%, model says overflow"
// report. The round's envelope total is capped; each envelope gets
// floor(BUDGET / N), floored so a wide batch still carries a usable gist.
export const SPAWN_ROUND_ENVELOPE_BUDGET = 12_000
export const MIN_SPAWN_ENVELOPE_BUDGET = 800
