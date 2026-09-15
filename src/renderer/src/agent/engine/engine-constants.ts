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
  // The page tools go over the wire to another process and into a live page;
  // a runaway string here is an in-page eval, not just a big prompt.
  page_execute_js: { script: 50_000 },
  page_input: { text: 100_000 },
}
export const MAX_TOOL_INPUT_JSON_BYTES = 1_000_000 // 1 MB safety net for any tool

// ── Background memory extraction cooldown ────────────────────────────────
export const MEM_EXTRACTION_COOLDOWN = 30_000
