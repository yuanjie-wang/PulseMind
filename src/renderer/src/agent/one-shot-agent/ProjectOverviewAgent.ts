import { OneShotAgent } from './OneShotAgent'
import { normalizeProjectOverview, PROJECT_OVERVIEW_MAX_LENGTH } from '../../../../shared/types/project'

export interface ProjectOverviewInput {
  /** 项目名称 — the one field that is always present. */
  name: string
  /** Per-conversation one-liners, pre-built by the caller as 「标题：…」 —
   *  the project's own conversations, newest first, already capped/truncated. */
  conversationBriefs?: string[]
  /** Top-level entry names of the project's workspace directory, capped. */
  workspaceEntries?: string[]
  locale?: 'zh' | 'en'
}

/** Writes the ≤50 字 project overview from whatever context exists. Same
 *  one-shot shape as TitleAgent: retry once on null, then give up (null) —
 *  the modal keeps whatever the user had typed and shows the failure itself.
 *  Deliberately NOT named AutoSummaryAgent — that class is the conversation
 *  auto-summary, an unrelated feature. */
export class ProjectOverviewAgent extends OneShotAgent<ProjectOverviewInput, string | null> {
  readonly name = 'ProjectOverviewAgent'

  protected buildSystemPrompt(input: ProjectOverviewInput): string {
    const en = input.locale === 'en'
    return en
      ? `You write project overviews for a workspace app.
Task: from the project name, its workspace folder contents and its conversations, write ONE overview line describing what this project is for.
Rules:
1. At most ${PROJECT_OVERVIEW_MAX_LENGTH} characters, one sentence, no line breaks;
2. State the project's purpose/goal, not a list of files;
3. Plain text only: no quotes, no emoji, no prefix like "Overview:", no trailing punctuation;
4. Output the overview text only — never ask questions or add any explanation.`
      : `你为工作台应用撰写项目概述。
任务：根据项目名称、工作区文件夹内容与项目下的会话，写一句概述，说明这个项目是做什么的。
约束规则：
1. 不超过${PROJECT_OVERVIEW_MAX_LENGTH}个字，一句话，不要换行；
2. 概括项目的目的或目标，不要罗列文件名；
3. 纯文本：不加引号、不用emoji、不要「概述：」之类前缀、结尾不要标点；
4. 只输出概述本身，严禁向用户提问、请求澄清或输出任何解释。`
  }

  protected buildUserMessages(input: ProjectOverviewInput): { role: string; content: string }[] {
    const lines: string[] = [`项目名称：${input.name}`]
    if (input.workspaceEntries?.length) {
      lines.push(`工作区顶层内容：${input.workspaceEntries.join('、')}`)
    }
    if (input.conversationBriefs?.length) {
      lines.push('项目下的会话：')
      for (const brief of input.conversationBriefs) lines.push(`- ${brief}`)
    }
    return [{ role: 'user', content: lines.join('\n') }]
  }

  protected parseResponse(raw: string, input: ProjectOverviewInput): string | null {
    void input
    // Same cleanup family as TitleAgent, with one difference: a WHOLLY fenced
    // answer (```\n概述\n```) is the answer wearing a fence, not code to drop —
    // its interior is extracted first, then the generic fence strip runs.
    const fenced = raw.match(/```[a-zA-Z]*\n?([\s\S]*?)```/)
    let cleaned = fenced && fenced[1].trim() ? fenced[1] : raw.replace(/```[\s\S]*?(?:```|$)/g, '')
    cleaned = cleaned.replace(/`([^`]*)`/g, '$1')
    cleaned = cleaned.replace(/<[^>]*>/g, '')
    // Drop a conversational lead-in the model sometimes adds despite the ban.
    cleaned = cleaned.replace(/^(?:概述|项目概述)(?:为|是)?[:：]\s*/, '')
    const firstLine =
      cleaned
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l) ?? ''
    return normalizeProjectOverview(firstLine.replace(/^["“”'']+|["“”'']+$/g, '')) ?? null
  }

  protected getDefaultOutput(input: ProjectOverviewInput): string | null {
    void input
    // No invented fallback: an overview the model failed to write must not
    // silently become the project name or a file list.
    return null
  }
}
