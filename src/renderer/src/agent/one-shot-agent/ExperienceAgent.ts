import { OneShotAgent } from './OneShotAgent'

export interface ExperienceInput {
  conversationText: string
  existingExperiencesText: string
  locale?: string
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

    const prompt = `Analyze the following conversation and determine if it contains any of:
- Workflow improvements, shortcuts, or process optimizations worth preserving as a reusable experience
- User complaints, frustrations, or pain points — negative feedback indicates issues worth recording as lessons learned

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

If the new insight is already well-covered by an existing experience, respond with:
Content: None

Otherwise, provide a unique experience.

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
