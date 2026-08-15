import { OneShotAgent } from './OneShotAgent'

export interface ExperienceInput {
  conversationText: string
  existingExperiencesText: string
  locale?: string
  stats?: { toolCallCount: number; toolErrorCount: number }
}

export interface ExperienceOutput {
  title: string
  content: string
  category: string
}

export class ExperienceAgent extends OneShotAgent<ExperienceInput, ExperienceOutput | null> {
  readonly name = 'ExperienceAgent'

  protected buildSystemPrompt(): string {
    return 'You are an expert at extracting actionable knowledge and user pain points from conversations.'
  }

  protected buildUserMessages(input: ExperienceInput): { role: string; content: string }[] {
    const langInstruction = input.locale === 'zh'
      ? '请用中文编写经验内容。'
      : 'Write the experience content in English.'

    const statsLine = input.stats
      ? `\nConversation statistics: ${input.stats.toolCallCount} tool call(s), ${input.stats.toolErrorCount} tool error(s).`
      : ''

    const prompt = `Analyze the following conversation and determine if it contains any of:
- Workflow improvements, shortcuts, or process optimizations worth preserving as a reusable experience
- User complaints, frustrations, or pain points — negative feedback indicates issues worth recording as lessons learned

QUALIFICATION GATE — ONLY extract an experience if the conversation contains at least ONE of these four situations:
1. A complex task completed successfully (5+ tool calls were made)
2. The agent hit a wall (failed attempts, errors, dead ends) and eventually found a viable path — the struggle itself is the lesson
3. The user corrected the agent's behavior or approach — the correction is worth remembering
4. A non-trivial workflow was discovered — a multi-step process, ordering, or technique that would save time next time

A casual chat, a simple question answered in one exchange, a one-off decision, or a task with no tools and no friction does NOT qualify.
If the conversation does NOT match any of the four situations, respond with:
Content: None
${statsLine}

Focus on whether there are ways to shorten or optimize repetitive steps, or whether the user expressed dissatisfaction that reveals a recurring problem.

If the conversation does NOT contain any meaningful insights, optimizations, or user complaints worth preserving, respond with:
Content: None

Otherwise, write a structured experience with a concise title and content organized into four sections:

**Title**: A short, descriptive title (max 30 chars). Choose a title that makes the experience easily identifiable in a list.

**Content** — use this Markdown format:
## 背景 (Background)
What prompted this? Context of the problem or task.

## 过程 (Process)
What was done? Key steps, approaches tried, tools used.

## 问题 (Problems)
What went wrong or was tricky? Pain points, pitfalls, frustrations.

## 优化 (Optimization)
Lessons learned, what to do differently next time, actionable takeaways.

- Category: one of "code", "architecture", "user_pref", "decision", "general" — choose the most relevant category for this experience

${langInstruction}

${input.existingExperiencesText}

STRICT DEDUPLICATION RULE: Before writing a new experience, carefully compare your insight against EVERY existing experience listed above. If the same optimization, lesson, or pain point is already covered — even with different wording — respond with:
Content: None

Only provide a NEW, genuinely distinct experience. Duplicates will be rejected.

Respond in this exact format:
Title: <title>
Category: <category>
Content:
<content>

Conversation:
${input.conversationText.slice(0, 30000)}`

    return [{ role: 'user', content: prompt }]
  }

  protected parseResponse(raw: string): ExperienceOutput | null {
    // Check for None signal
    if (/^Content:\s*None\s*$/m.test(raw)) return null

    const titleMatch = raw.match(/^Title:\s*(.+)$/m)
    const title = titleMatch?.[1]?.trim() || ''

    const catMatch = raw.match(/^Category:\s*(.+)$/m)
    const category = catMatch?.[1]?.trim().toLowerCase() || 'general'
    const validCategories = ['code', 'architecture', 'user_pref', 'decision', 'general']
    const finalCategory = validCategories.includes(category) ? category : 'general'

    // Find Content: line and extract everything after the prefix
    const contentStartMatch = raw.match(/^Content:\s*/m)
    if (!contentStartMatch) return null

    const content = raw.slice(contentStartMatch.index! + contentStartMatch[0].length).trim()
    if (!content) return null

    return { title, content, category: finalCategory }
  }

  protected getDefaultOutput(): ExperienceOutput | null {
    return null
  }
}
