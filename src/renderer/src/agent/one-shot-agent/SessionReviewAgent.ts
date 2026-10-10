// ── Session review one-shot ──
// Runs once at session end (afterSession hook, both renderer and main hosts):
// a single LLM pass over the transcript that extracts memories, a title
// summary + search keywords, and optionally an experience record in one call.
// Dedupes against existing memories passed in via the prompt.

import { OneShotAgent } from './OneShotAgent'
import { extractJson } from './json-utils'
import { parseScriptFences } from '../../../../shared/experience/script-fence'
import type { ExtractedMemory } from './MemoryExtractionAgent'

export interface SessionReviewInput {
  sessionSummary: string
  existingExperiencesText?: string
  existingMemoriesText?: string
  locale?: string
}

export interface SessionReviewOutput {
  memories: ExtractedMemory[]
  summary?: string
  keywords?: string[]
  experience?: {
    title: string
    content: string
    category: string
    files?: { path: string; content: string }[]
    /** THREE-WAY protocol (PLAN-experience-iteration): 'create' (default) makes
     *  a new pool record; 'update' says `content` is the full revised document
     *  OF `target` (a pool record name). parseResponse degrades a bad update
     *  to 'create' rather than drop the insight. */
    action?: 'create' | 'update'
    target?: string
  } | null
}

export class SessionReviewAgent extends OneShotAgent<SessionReviewInput, SessionReviewOutput> {
  readonly name = 'SessionReviewAgent'

  protected buildSystemPrompt(): string {
    return `\
You are a session review system. Analyze the conversation below and extract two kinds of information in a single pass:

## A. Memories
A memory is knowledge about THE USER that makes the next conversation serve them better. Every memory must be attributable to the user — something they decided, prefer, corrected, or their durable background. The conversation transcript is only the EVIDENCE; what gets saved is what it reveals about the user, never a recap of the work itself. Each memory must have:
- "content": specific and durable, anchored on the user ("用户拍板…", "用户要求…", "用户习惯…", "用户的背景是…"). HARD CAP: at most 100 characters, ONE short sentence (短句) stating the conclusion — no recipes, no step lists, no examples. If the insight cannot compress to one short sentence, it belongs in the experience record, not here
- "type": one of "fact", "decision", "preference"
  - "decision" — a choice the USER made or ratified: scope, approach or tool pick, priorities, a rejected alternative, a deliverable spec/口径 they signed off on
  - "preference" — how the user wants things done: language, tone, format templates, granularity, workflow habits, and every correction they made to the agent's behavior or output
  - "fact" — the user's background: role, organization, ongoing projects, domain context, and domain facts the user explicitly confirmed
- "category": one of "code", "architecture", "user_pref", "decision", "general"

NOT memories — never extract these, no matter how substantial they look:
- The assistant's own analysis, frameworks, research findings, or summaries of files/webpages it read. The model's output is work product, not user knowledge — UNLESS the user explicitly approved or adopted it, which turns it into a "decision".
- A log of what was done in one task ("查了X的天气", "完成了Y的调研") — execution narration is not durable knowledge.
- Casual chat and greetings.

Litmus test: if this memory disappeared, would the NEXT conversation for this user be visibly worse? If not, skip it.

Yield bar: extraction is SELECTIVE, not exhaustive. At most 3 memories per review — only items clearing every rule above. Most conversations correctly yield ZERO memories: "memories": [] is a fully successful outcome, never pad and never lower the bar to have something to show. One high-value memory beats five marginal ones.

Important: If existing memories are provided, ONLY output memories that are NOT already covered by them. Skip any fact, decision, or preference that duplicates or substantially overlaps an existing memory.

Also generate:
- "summary": a short phrase (max 200 chars) describing this conversation
- "keywords": array of search keywords (max 10, prefer Chinese if conversation is in Chinese)

## B. Experience (optional)

### B1. QUALIFICATION GATE — pass this BEFORE writing anything
The conversation summary begins with a line like "(Conversation statistics: N tool call(s), M tool error(s))". Use it. Extract an experience ONLY if the conversation contains at least ONE of these four situations:
1. A complex task completed successfully (the statistics show 5+ tool calls)
2. The agent hit a wall (failed attempts, errors, dead ends — the statistics show tool errors, or the transcript shows repeated failures) and eventually found a viable path — the struggle itself is the lesson
3. The user corrected the agent's behavior or approach — the correction is worth remembering
4. A non-trivial workflow was discovered — a multi-step process, ordering, or technique that would save time next time

A casual chat, a simple question answered in one exchange, a one-off decision, or a task with no tools and no friction does NOT qualify. When the statistics show few tool calls, zero tool errors, AND the transcript carries no correction or pain point — set "experience" to null.

Two types of valuable experience, once the gate passes:
**Optimizations:** A repetitive task was simplified, a workflow shortcut discovered, a process improvement found through trial and error. Worth remembering because the same situation will come up again.

**User pain points:** The user expressed frustration, dissatisfaction, or pushed back on an approach. This signals a recurring problem worth avoiding in the future.

An experience has:
- "title": a short, descriptive title (max 30 chars). Choose a title that makes the experience easily identifiable in a list.
- "content": structured Markdown with four sections:
  - ## 背景 (Background) — What prompted this? Context of the problem or task.
  - ## 过程 (Process) — What was done? Key steps, approaches tried, tools used.
  - ## 问题 (Problems) — What went wrong or was tricky? Pain points, pitfalls, frustrations.
  - ## 优化 (Optimization) — Lessons learned, what to do differently next time, actionable takeaways.
- "category": one of "code", "architecture", "user_pref", "decision", "general" — choose the most relevant category

### B2. DUPLICATES / EXTENDS / NEW — the three ways an insight meets the pool
When EXISTING EXPERIENCES is provided, compare your insight against EVERY entry and pick exactly one:
- **DUPLICATES** — an existing entry already covers this lesson (even worded differently): set "experience" to null.
- **EXTENDS** — an existing entry covers the SAME subject and this conversation adds to it (a new pitfall, a correction, a better step, a script worth keeping alongside): set "action": "update" and "target" to that entry's name (the first field of its "- name | category | ..." line, copy it verbatim). "content" is then the FULL revised document — keep every paragraph of the existing entry that still holds, fold the new lesson into the matching section, and do NOT truncate. An entry whose body ends with the「正文被截断」marker was only partially shown: you do NOT have the whole document, so DO NOT revise that entry from the excerpt — pick NEW (or skip) instead. The store rejects a revision whose content is much shorter than the record it would overwrite, and such a rejection counts as a failed save.
- **NEW** — no entry covers it: set "action": "create" (or omit "action"; create is the default) with the new title.

If "action" is "update", the store overwrites the target record with your "content" — a partial fragment would destroy the entry, so always send the complete merged document.

### Deterministic, repeatable work → ship a SCRIPT
When the conversation contains fixed, deterministic, re-runnable work (the exact same steps would run again), ALSO distill it into an executable Node script instead of leaving it as prose. Declare it inside "content" as a fenced block:

### File: scripts/<name>.mjs
\`\`\`js
<complete script source>
\`\`\`

followed by a "## 脚本 (Script)" section in the content that documents each script: purpose, exact invocation, parameters, preconditions, and where its output lands.

Script hard requirements (violating any makes the script useless):
- Node.js 20, ONLY built-in modules prefixed with "node:" (fs, path, ...). The app ships Node 20 with NO npm — a script depending on an npm package can never run on any machine.
- Parameterize EVERYTHING through process.argv / environment variables. Hard-coding values from THIS conversation (paths, ids, urls) is the classic dead script.
- Deterministic output, idempotent re-runs, single file, at most 3 files per experience.
- Write shell/python steps as plain text in the 过程/优化 sections instead — they are NOT portable.
If the work is judgment-based (not mechanically repeatable), do NOT invent a script.

On an "update": a script that CHANGES goes in a fence with the SAME path — it overwrites the old file. Scripts you are not changing must NOT be re-emitted (files not listed are left untouched on disk). A script that is now wrong should simply be omitted from the revised content.

If this conversation doesn't contain any worthwhile lessons, set "experience" to null.

## Output Format
Return ONLY a JSON object with these keys:
{
  "memories": [{ "content": "...", "type": "fact|decision|preference", "category": "code|architecture|user_pref|decision|general" }],
  "summary": "...",
  "keywords": ["...", "..."],
  "experience": { "action": "create|update", "target": "<existing name, only when action=update>", "title": "...", "content": "...", "category": "code|architecture|user_pref|decision|general" } | null
}`
  }

  protected buildUserMessages(input: SessionReviewInput): { role: string; content: string }[] {
    const langInstruction = input.locale === 'zh'
      ? '请用中文编写 experience 的 content。'
      : 'Write the experience content in English.'

    const memoriesSection = input.existingMemoriesText
      ? `\n\nEXISTING MEMORIES (do NOT output a memory that duplicates any of these):\n${input.existingMemoriesText}`
      : ''

    const existingSection = input.existingExperiencesText
      ? `\n\nEXISTING EXPERIENCES (the live experience pool — decide DUPLICATES / EXTENDS / NEW against these; each line is "- name | category | description" followed by the entry's body):\n${input.existingExperiencesText}`
      : ''

    return [{
      role: 'user',
      content: `Review this conversation and extract memories + optional experience.\n${langInstruction}${memoriesSection}${existingSection}\n\n${input.sessionSummary}`
    }]
  }

  protected parseResponse(raw: string, input: SessionReviewInput): SessionReviewOutput {
    const parsed = extractJson<{
      memories?: unknown[]
      summary?: string
      keywords?: unknown[]
      experience?: { title?: string; content?: string; category?: string; action?: string; target?: string } | null
    }>(raw)

    if (!parsed) return this.getDefaultOutput()

    // Support old format (array of memories only)
    if (Array.isArray(parsed)) {
      return { memories: parsed as ExtractedMemory[] }
    }

    return {
      memories: Array.isArray(parsed.memories) ? parsed.memories as ExtractedMemory[] : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k: unknown) => typeof k === 'string') : undefined,
      experience: parsed.experience && typeof parsed.experience === 'object' && parsed.experience.content && parsed.experience.content !== 'None'
        ? (() => {
            const content = typeof parsed.experience.content === 'string' ? parsed.experience.content : ''
            // Script fences ride INSIDE content; split them out here (P1.2 of
            // PLAN-experience-scripts). Rejected files are the store gates'
            // concern — parse only splits and prefix-checks.
            const { content: body, files } = parseScriptFences(content)
            // THREE-WAY protocol: an update must name a record the model was
            // actually shown. Unknown/missing target degrades to create —
            // 宁可多一条不可丢洞见 (the store has the same fallback for a
            // target evicted between prompt-build and save).
            const poolNames = poolNamesOf(input.existingExperiencesText)
            const wantsUpdate = parsed.experience.action === 'update'
            const target = typeof parsed.experience.target === 'string' ? parsed.experience.target.trim() : ''
            const validTarget = wantsUpdate && target && poolNames.has(target)
            if (wantsUpdate && !validTarget) {
              console.warn(`[SessionReviewAgent] update target ${target ? `"${target}" not in the pool` : 'missing'} — degrading to create`)
            }
            return {
              title: typeof parsed.experience.title === 'string' ? parsed.experience.title : '',
              content: body,
              category: typeof parsed.experience.category === 'string' ? parsed.experience.category : 'general',
              files: files.length > 0 ? files : undefined,
              action: validTarget ? 'update' as const : 'create' as const,
              target: validTarget ? target : undefined,
            }
          })()
        : null
    }
  }

  protected getDefaultOutput(): SessionReviewOutput {
    return { memories: [] }
  }
}

/** The set of pool record names the prompt actually showed the model — the
 *  first field of each "- name | category | description" line. An `update`
 *  target outside this set is a hallucination and degrades to create. */
export function poolNamesOf(existingExperiencesText?: string): Set<string> {
  const names = new Set<string>()
  if (!existingExperiencesText) return names
  for (const line of existingExperiencesText.split('\n')) {
    const m = line.match(/^- (\S+) \| /)
    if (m) names.add(m[1])
  }
  return names
}
