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

// ── Mid-stream network-failure retry (12h unattended runs) ────────────
// The idle-timeout retry covers a STALLED stream (proxy aborts after 60s of
// silence). A stream can also DIE actively, and every one of those shapes used
// to end the turn as a hard error — the one failure an unattended run cannot
// survive (one mid-stream TCP reset = the whole task marked failed):
//   - connection reset mid-body (undici: 'terminated' / 'other side closed' /
//     cause ECONNRESET / 'socket hang up');
//   - fetchWithRetry exhausting its 20 backoff attempts during a longer
//     network outage ('fetch failed' + a connect/DNS cause);
//   - the proxy's EXTERNAL abort — sleep/resume cancelAllRequests aborts every
//     pending stream 3s after wake ('Request aborted'). User-stop never
//     reaches this matcher: it sets isCancelled first and the catch's isCancel
//     arm swallows the error; dispose/steer/retry register the request id in
//     cancelledRequestIds the same way.
// These share the idle-timeout budget (streamIdleRetries): consecutive
// transport failures of any kind are one scarce resource. HTTP status errors
// are deliberately excluded (see the 'HTTP ' guard in stream-runner): 4xx are
// semantic (auth, request shape) and 429/5xx already got the proxy's 20
// backoff attempts before surfacing here.
export const STREAM_NETWORK_ERROR_MARKERS = [
  'Request aborted',
  'fetch failed',
  'terminated',
  'other side closed',
  'socket hang up',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]

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

// ── Early-stop continuation guard (per-model opt-in) ───────────────────
// A weak model's chat prior makes it narrate the next step as prose and end
// the turn (end_turn, visible text, no tool_use) while the task is clearly
// still in flight. The user's measured pattern that shaped it: nudging with a
// bare 「继续」 reliably resumes the work — so the engine automates exactly
// that, gated by opts.earlyStopGuard (a LlmModelConfig flag; models without
// it never see the guard). The nudge rides the state block (never persisted,
// never rendered); the completion signal is the <<TASK_DONE>> sentinel taught
// by the frozen core's TASK_COMPLETION_SENTINEL_SECTION and decoded by
// engine/task-sentinel.ts. Two counters, two scopes: one nudge per PROGRESS
// STRETCH (a continuation that produced tool calls re-arms it — the manual
// pattern was "keep nudging while it makes progress"), bounded to the cap
// below per turn so a model that stops after every sentence cannot multiply
// the request count without limit.
export const MAX_EARLYSTOP_CONTINUATIONS = 10

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

// ── Live terminal-output cap ───────────────────────────────────────────
// The engine-side accumulation of a RUNNING process's output (execution-flow's
// shell path and domain-tools' exec executor) used to be unbounded: a `tail
// -f`-style process grew the buffer — and the tool_use block it rides on — for
// as long as it ran, in the MAIN process (the engine's host), with no ceiling.
// The cap mirrors the session-manager's wire cap (200K chars, head-kept): past
// it the live block freezes on the first 200K, which is exactly what the
// renderer was already shown (the wire caps the same way), and the frozen head
// also freezes the tool_status diff signature, so per-tick wire updates stop.
// The FULL stream still lands in the proc-log (main/services/terminal.ts,
// 8MB/file) and the settled result still goes through addToolResult's budget
// (4K normal / MAX_ERROR_RESULT_TOKENS for errors) + tmp/trunc offload — what
// the cap bounds is only the live in-memory copy (and with it, the trunc
// offload for >200K outputs: head-200K instead of the whole stream).
export const MAX_LIVE_OUTPUT_CHARS = 200_000

// ── Tool-result / spawn-envelope context guardrails ─────────────────────
// Per-tool-result token budget enforced by the engine's addToolResult (anything
// over the caller's budget is head+tail truncated with the full text offloaded
// to ~/.pulsemind/tmp/trunc/ for the model to read back). Lives here — not on
// AgentEngine — because spawn-tool sizes the batch-split envelope budget from
// it, and importing AgentEngine from an executor would close a cycle
// (AgentEngine → tool-executors → executors/spawn-tool → AgentEngine).
export const MAX_TOOL_RESULT_TOKENS = 4_000

// Errors get a WIDER but FINITE budget (review_20261028 中1): the old
// "errors pass whole" short-circuit let one failed build ride its full stack
// — or a 200K-char exec transcript — into the context ungated, and the
// collector message it lands in sits inside every compaction layer's
// protection window. 4× the normal line is generous headroom for stack
// traces and rejection envelopes while still capping the blast radius;
// the overflow tail gets the standard head+tail + tmp/trunc offload. A
// caller that grants MORE than this line (read's 30K) keeps its grant.
export const MAX_ERROR_RESULT_TOKENS = 4 * MAX_TOOL_RESULT_TOKENS

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

// ── read paging (2026-10-29: one source of truth) ──────────────────────
// These two numbers used to live on BOTH sides of the read seam —
// tool-executors held {default 500, cap 1000}, command-builder independently
// clamped every page to 500 — and the executor's metadata header computed
// `Range:` from the REQUESTED limit. So `read limit:1000` on a long file
// returned 500 lines under a header claiming "lines 1-1000": the model
// resumed at 1001 and lines 501-1000 vanished with no error anywhere. The
// 500 in command-builder traced back to "read bypasses the token guardrail",
// a premise 9d93caf retired when read got its own MAX_READ_RESULT_TOKENS —
// the command's own comment already said overflow was that budget's job.
// Both sides import from here now; the header derives its range from the
// content actually delivered, so the two can never disagree again.
export const READ_DEFAULT_LINE_LIMIT = 500
export const READ_MAX_LINE_LIMIT = 1000

// spawn_agent envelopes share ONE budget per assistant round: 11 parallel
// experts each returning up to 4k tokens would append ~44k tokens in a single
// collector message — which sits in every compaction layer's protection
// window, so nothing can relieve it before the next request goes out. That
// message is the shape behind the 0.4.1 "ring says 35%, model says overflow"
// report. The round's envelope total is capped; each envelope gets
// floor(BUDGET / N), floored so a wide batch still carries a usable gist.
export const SPAWN_ROUND_ENVELOPE_BUDGET = 12_000
export const MIN_SPAWN_ENVELOPE_BUDGET = 800
