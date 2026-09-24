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
  } | null
}

export class SessionReviewAgent extends OneShotAgent<SessionReviewInput, SessionReviewOutput> {
  readonly name = 'SessionReviewAgent'

  protected buildSystemPrompt(): string {
    return `\
You are a session review system. Analyze the conversation below and extract two kinds of information in a single pass:

## A. Memories
Extract important facts, decisions, and user preferences. Each memory must have:
- "content": specific, durable information (not transient chat)
- "type": one of "fact", "decision", "preference"
- "category": one of "code", "architecture", "user_pref", "decision", "general"

Important: If existing memories are provided, ONLY output memories that are NOT already covered by them. Skip any fact, decision, or preference that duplicates or substantially overlaps an existing memory.

Also generate:
- "summary": a short phrase (max 200 chars) describing this conversation
- "keywords": array of search keywords (max 10, prefer Chinese if conversation is in Chinese)

## B. Experience (optional)
Determine if the conversation contains lessons or observations worth remembering for future work. There are two types of valuable experience:

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

If this conversation doesn't contain any worthwhile lessons, set "experience" to null.

Important: If existing experiences are provided, ONLY output an experience that is NOT already covered by them. If the insight duplicates an existing experience, set "experience" to null.

## Output Format
Return ONLY a JSON object with these keys:
{
  "memories": [{ "content": "...", "type": "fact|decision|preference", "category": "code|architecture|user_pref|decision|general" }],
  "summary": "...",
  "keywords": ["...", "..."],
  "experience": { "title": "...", "content": "...", "category": "code|architecture|user_pref|decision|general" } | null
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
      ? `\n\nEXISTING EXPERIENCES (check if new insight relates to or duplicates any of these):\n${input.existingExperiencesText}`
      : ''

    return [{
      role: 'user',
      content: `Review this conversation and extract memories + optional experience.\n${langInstruction}${memoriesSection}${existingSection}\n\n${input.sessionSummary}`
    }]
  }

  protected parseResponse(raw: string): SessionReviewOutput {
    const parsed = extractJson<{
      memories?: unknown[]
      summary?: string
      keywords?: unknown[]
      experience?: { title?: string; content?: string; category?: string } | null
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
            return {
              title: typeof parsed.experience.title === 'string' ? parsed.experience.title : '',
              content: body,
              category: typeof parsed.experience.category === 'string' ? parsed.experience.category : 'general',
              files: files.length > 0 ? files : undefined,
            }
          })()
        : null
    }
  }

  protected getDefaultOutput(): SessionReviewOutput {
    return { memories: [] }
  }
}
