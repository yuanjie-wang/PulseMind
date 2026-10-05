import { OneShotAgent } from './OneShotAgent'

export interface HistorySummaryInput {
  /** Condensed text of the conversation region being dropped (built by AgentEngine). */
  regionText: string
  /** Extra emphasis for the summary, from an explicit /compact 指示词. Rides
   *  the user message so the strict system-prompt rules above stay intact. */
  instruction?: string
  locale?: string
  /** 'region' (default — first build / extension: the input is a raw
   *  conversation region) vs 'roll' (the input is an ACCUMULATED summary
   *  chain past HISTORY_SUMMARY_MAX_CHARS — consolidation, not first
   *  compression). An explicit param rather than sniffing the text for
   *  section markers: the chain can carry model-written 【交接笔记】. */
  mode?: 'region' | 'roll'
}

// The section skeleton is FIXED — the same 【…】 headers in every locale. They
// sit inside the mechanical 【历史对话摘要】 wrapper (locale-free by house
// style) and must stay machine-recognizable so a rolled chain can be
// consolidated section-wise instead of re-invented from prose
// (PLAN-context-summary-structure).
const REGION_PROMPT_ZH = `你是对话历史摘要器。
任务：将下面的对话历史压缩为一份结构化摘要，供后续对话在被压缩掉的上下文之外延续工作。
输出固定使用以下三节，节标题原样使用【…】格式，不增删节、不改节名：
【用户诉求与决策】用户的诉求、已拍板的决策、用户的纠正与约束。
【任务执行情况】已完成 / 进行中 / 待办 / 失败教训（试过什么不行、应改用什么），以最新状态为准。
【文件与产物】涉及文件的路径与对它们做了什么、结果如何，路径逐字保留。
格式约束：
1. 每节用「- 」开头的短条目，每条不超过 40 字，每节最多 5 条；无内容的节写「无」，不要凑字；
2. 全文不超过 500 字；
3. 只输出摘要正文，不要解释或任何额外文字；
4. 严禁向用户提问、请求澄清或索要更多信息；
5. 用对话本身的语言输出。`

const REGION_PROMPT_EN = `You are a conversation-history summarizer.
Task: compress the conversation history below into a structured summary, so the conversation can continue beyond the compacted-away context.
Use EXACTLY the three sections below — keep the 【…】 headers verbatim; never add, drop, or rename a section:
【用户诉求与决策】 the user's asks, decisions already made, the user's corrections and constraints.
【任务执行情况】 done / in progress / pending / failed attempts (what failed, what to use instead), latest state first.
【文件与产物】 file paths touched, what was done to them and the outcome; keep paths verbatim.
Format rules:
1. Each section holds short "- " bullets of at most 40 characters, at most 5 per section; write 无 in an empty section — never pad;
2. Keep the whole summary under 500 characters;
3. Output only the summary body — no explanations or extra text;
4. Never ask the user questions, request clarification, or ask for more information;
5. Output in the same language as the conversation.`

const ROLL_PROMPT_ZH = `你是对话历史摘要器。下面的文本不是原始对话，而是此前多次累积的摘要链（可能含重复的节标题与【交接笔记】）。
任务：把它归并为一份结构化摘要，供后续对话在被压缩掉的上下文之外延续工作。
归并规则：
1. 输出固定三节，节标题原样使用【…】格式：【用户诉求与决策】【任务执行情况】【文件与产物】，不增删节、不改节名；
2. 【用户诉求与决策】：取并集去重，用户的纠正与约束全部保留；
3. 【任务执行情况】：以最新状态归并，已完成的不重复罗列，失败教训保留；
4. 【文件与产物】：文件路径全部保留、逐字不改；
5. 输入中的【交接笔记】是模型的逐字交接内容，若存在则原样保留，不改写、不删减；
6. 每节用「- 」开头的短条目，每条不超过 40 字，每节最多 5 条；无内容的节写「无」；
7. 全文不超过 800 字；
8. 只输出归并后的摘要正文，不要解释；严禁向用户提问；用对话本身的语言输出。`

const ROLL_PROMPT_EN = `You are a conversation-history summarizer. The text below is NOT a raw conversation — it is an accumulated chain of earlier summaries (possibly with repeated section headers and a 【交接笔记】 block).
Task: consolidate it into one structured summary, so the conversation can continue beyond the compacted-away context.
Consolidation rules:
1. Output EXACTLY three sections with the 【…】 headers verbatim: 【用户诉求与决策】 【任务执行情况】 【文件与产物】; never add, drop, or rename a section;
2. 【用户诉求与决策】: merge and deduplicate; keep every user correction and constraint;
3. 【任务执行情况】: consolidate to the latest state; do not repeat completed items; keep failed-attempt lessons;
4. 【文件与产物】: keep every file path verbatim;
5. A 【交接笔记】 block in the input is the model's verbatim handover note — preserve it as-is when present; never rewrite or trim it;
6. Each section holds short "- " bullets of at most 40 characters, at most 5 per section; write 无 in an empty section;
7. Keep the whole summary under 800 characters;
8. Output only the consolidated body — no explanations; never ask the user questions; output in the same language as the conversation.`

/**
 * Summarizes a dropped conversation region before hardTruncate discards it.
 * The output is a STRUCTURED body (three fixed sections) injected into the API
 * copy only — it never reaches this.messages or the UI, so it stays plain
 * text beyond the section headers and "- " bullets.
 */
export class HistorySummaryAgent extends OneShotAgent<HistorySummaryInput, string> {
  readonly name = 'HistorySummaryAgent'

  protected buildSystemPrompt(input: HistorySummaryInput): string {
    const isZh = input.locale === 'zh'
    if (input.mode === 'roll') return isZh ? ROLL_PROMPT_ZH : ROLL_PROMPT_EN
    return isZh ? REGION_PROMPT_ZH : REGION_PROMPT_EN
  }

  protected buildUserMessages(input: HistorySummaryInput): { role: string; content: string }[] {
    const instruction = input.instruction?.trim()
    return [{
      role: 'user',
      content: instruction ? `${input.regionText}\n\n[摘要额外要求] ${instruction}` : input.regionText,
    }]
  }

  protected parseResponse(raw: string): string {
    // Strip markdown fences and lead-ins, keep the plain summary body. A fully
    // fenced response keeps its body — only the markers go (the old blanket
    // regex deleted the fenced content whole, so a model wrapping the
    // structured summary in ```…``` produced an empty summary); stray fences
    // elsewhere still strip with the blanket rule. The 2000-char ceiling gives
    // the roll's 800-char consolidated target headroom while still bounding a
    // runaway output — the old 800-char slice was sized for one prose
    // paragraph, not a structured body.
    let cleaned = raw.trim()
    const fenced = cleaned.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
    cleaned = (fenced ? fenced[1] : cleaned.replace(/```[\s\S]*?(?:```|$)/g, '')).trim()
    cleaned = cleaned.replace(/^(?:摘要(?:为|是)?|总结(?:为|是)?|历史摘要)[:：]?\s*/i, '').trim()
    return cleaned.slice(0, 2000)
  }

  protected getDefaultOutput(): string {
    // Empty → AgentEngine falls back to plain truncation (current behavior).
    return ''
  }
}
