/** Probe entry — bundled by esbuild into out/probe-compaction-replay.bundle.cjs
 *  so scripts/probe-compaction-replay.mjs can drive the REAL request-build
 *  pipeline (not a re-implementation) over a transcript reconstructed from the
 *  DB. Imported nowhere in the app. */
export {
  ContextCompactor,
  COPY_CALIBRATION_MIN,
  COPY_CALIBRATION_MAX,
  dropStaleThinkingOnlyTurns,
  estimateAfterNanoTokens,
  lastTextUserMessageIndex,
} from '../src/renderer/src/agent/engine/context-compactor'
export { copyTokensOf, estimateMessagesTokens, estimateTextTokens, requestTokensOf } from '../src/renderer/src/agent/engine/context-estimate'
export { effectiveInputWindow } from '../src/renderer/src/agent/engine/window-budget'
export { openaiAdapter } from '../src/renderer/src/llm/OpenAIAdapter'
export { regroupToolResults } from '../src/renderer/src/llm/regroup-tool-results'
export { elideTodoWritePairs } from '../src/renderer/src/llm/elide-todo-pairs'
export { stripToolResultImages } from '../src/renderer/src/agent/strip-tool-results'
