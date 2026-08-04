import { OneShotAgent } from './OneShotAgent'

// Reasoning models (DeepSeek R1 etc.) sometimes answer the title task with a
// clarifying question or meta-commentary instead of a title. These patterns
// detect that conversational output so it can be rejected and replaced with a
// title derived from the input.
const META_PATTERNS = [
  /[？?]/,
  /请(?:提供|告诉|说明|给我|让我|详细|先|进一步|输入|描述|分享)/,
  /请问|能否|可以吗|我需要|我想(?:更|深入|进一步)|根据我们|基于我们|更深入地了解|更多信息|具体问题|背景信息|澄清|明确一下|补充说明/,
]

export interface TitleInput {
  userMessage: string
  conversationContext?: string
  locale?: string
}

export class TitleAgent extends OneShotAgent<TitleInput, string | null> {
  readonly name = 'TitleAgent'

  protected buildSystemPrompt(input: TitleInput): string {
    void input
    return `你是对话标题生成器。
任务：根据完整的用户与助手对话内容，生成对话标题。
约束规则：
1. 标题使用中文，长度控制在4–16个字，禁用emoji；
2. 提炼整场对话核心主题，不要冗余修饰；
3. 禁止添加表情符号，标题末尾不要多余标点；
4. 不要直接复制用户问句，提炼核心诉求；
5. 只输出标题本身，不要输出任何解释、额外文字。
6. 无论输入内容多少，都必须直接生成标题，严禁向用户提问、请求澄清或索要更多信息；
7. 严禁输出对话性、解释性或元评论内容（如“请提供更多信息”“请问能否……”“根据我们之前的对话……”等）。`
  }

  protected buildUserMessages(input: TitleInput): { role: string; content: string }[] {
    const stripFileMarkers = (s: string) => s.replace(/\[(?:file|folder):[^\]]+\]/g, '').trim()
    const raw = input.conversationContext || input.userMessage.slice(0, 500)
    const content = stripFileMarkers(raw) || raw.slice(0, 500)
    return [{ role: 'user', content }]
  }

  protected parseResponse(raw: string, input: TitleInput): string | null {
    // Strip markdown code fences (```html, ```, etc.) — matched or unmatched opening fences
    let cleaned = raw.replace(/```[\s\S]*?(?:```|$)/g, '').trim()
    // Strip inline backticks
    cleaned = cleaned.replace(/`[^`]*`/g, '').trim()
    // Strip HTML tags
    cleaned = cleaned.replace(/<[^>]*>/g, '').trim()
    // Strip various quote characters
    cleaned = cleaned.replace(/["""'']/g, '').trim()
    // Strip verbose lead-ins like "标题为：" / "我建议标题是："
    cleaned = cleaned.replace(/^(?:我建议|建议|可以为|可以叫|标题(?:为|是)?)[:：]?\s*/, '').trim()
    // If the result looks like code/tags or is a clarification/meta reply, fall
    // back to a title derived from the input instead of passing it through.
    if (!cleaned || /^</.test(cleaned) || this.isMetaOutput(cleaned)) {
      return this.deriveFallback(input)
    }
    return cleaned.slice(0, 50) || null
  }

  protected getDefaultOutput(input: TitleInput): string | null {
    return this.deriveFallback(input)
  }

  /** Reject conversational / meta output (clarifying questions, requests for more info). */
  private isMetaOutput(text: string): boolean {
    if (text.length > 30) return true
    return META_PATTERNS.some((p) => p.test(text))
  }

  /** Derive a short title from the available input when the LLM output is unusable. */
  private deriveFallback(input: TitleInput): string | null {
    const stripFileMarkers = (s: string) => s.replace(/\[(?:file|folder):[^\]]+\]/g, '').trim()
    const raw = input.conversationContext || input.userMessage || ''
    const clean = stripFileMarkers(raw) || raw.trim()
    if (!clean) return null
    // Prefer the first clause of the first user message; strip the "User:" label
    // that conversationContext prefixes onto each line.
    const normalized = clean.replace(/^User:\s*/i, '')
    const clause = normalized.split(/[。！？!?；;\n，,]/)[0].trim()
    return (clause || normalized).slice(0, 16) || null
  }
}
