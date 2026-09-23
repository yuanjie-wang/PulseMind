// ── Engine tuning constants (moved off AgentEngine statics 0.4.1) ──
// The engine/* strategy modules need these values but must not depend on the
// concrete AgentEngine class; plain consts break that edge. Nothing outside
// agent/engine/ referenced the old statics.

// ── Stream idle-timeout retry ──────────────────────────────────────────
// The main-process proxy aborts streams that stay idle for 120s (long silent
// thinking, network blips). Instead of failing, re-issue the request a few
// times — the messages array is untouched until onStreamComplete, so a retry
// simply re-generates from scratch.
export const MAX_STREAM_IDLE_RETRIES = 2
export const STREAM_IDLE_TIMEOUT_MARKERS = ['闲置超时', 'Stream idle timeout']

// ── Tool parameter size limits ──────────────────────────────────────────
// Prevents the LLM from passing overly large arguments (e.g. write content,
// edit diffs) that would waste tokens or cause memory issues.
export const TOOL_PARAM_LIMITS: Record<string, Record<string, number>> = {
  write: { content: 500_000 },
  edit: { diff: 200_000, new_str: 200_000 },
  spawn_agent: { task: 200_000 },
  // PLAN-office-editing: the ops array rides the tool call into the engine.
  docx_edit: { ops: 120_000 },
  xlsx_edit: { ops: 120_000 },
  // The page tools go over the wire to another process and into a live page;
  // a runaway string here is an in-page eval, not just a big prompt.
  page_execute_js: { script: 50_000 },
  page_input: { text: 100_000 },
}
export const MAX_TOOL_INPUT_JSON_BYTES = 1_000_000 // 1 MB safety net for any tool

// ── Background memory extraction cooldown ────────────────────────────────
export const MEM_EXTRACTION_COOLDOWN = 30_000

// ── Tool-result / spawn-envelope context guardrails ─────────────────────
// Per-tool-result token budget enforced by the engine's addToolResult (errors
// pass whole; anything over is head+tail truncated with the full text offloaded
// to ~/.pulsemind/tmp/trunc/ for the model to read back). Lives here — not on
// AgentEngine — because spawn-tool sizes the batch-split envelope budget from
// it, and importing AgentEngine from an executor would close a cycle
// (AgentEngine → tool-executors → executors/spawn-tool → AgentEngine).
export const MAX_TOOL_RESULT_TOKENS = 4_000

// spawn_agent envelopes share ONE budget per assistant round: 11 parallel
// experts each returning up to 4k tokens would append ~44k tokens in a single
// collector message — which sits in every compaction layer's protection
// window, so nothing can relieve it before the next request goes out. That
// message is the shape behind the 0.4.1 "ring says 35%, model says overflow"
// report. The round's envelope total is capped; each envelope gets
// floor(BUDGET / N), floored so a wide batch still carries a usable gist.
export const SPAWN_ROUND_ENVELOPE_BUDGET = 12_000
export const MIN_SPAWN_ENVELOPE_BUDGET = 800
