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
    // Strip markdown fences and lead-ins, keep the plain summary body. The
    // strategy is layered (details at each layer below): fences are paired
    // line-wise into regions; a region carrying the fixed section header IS
    // the body; else a fully-fenced response keeps its body minus the
    // markers; else stray fences strip with the old blanket rule. The
    // 2000-char ceiling gives the roll's 800-char consolidated target
    // headroom while still bounding a runaway output — the old 800-char slice
    // was sized for one prose paragraph, not a structured body.
    let cleaned = raw.trim()
    // The fence we rescue is the one carrying the fixed section header: the
    // structured template makes the model MORE likely to wrap the summary in
    // ```…```, and a lead-in line (「好的，以下是摘要：」) or a trailer
    // (「以上是摘要」) defeats the old `^```…```$` anchor — the blanket rule
    // then ate the whole body and the surviving 9-char announcement LANDED as
    // the summary, stamping the dropped region covered with a ghost
    // (review_20261006 中6). A fenced CODE snippet beside an unfenced summary
    // must not be mistaken for the body, so the header fence wins over mere
    // position; a headerless fenced body keeps the old anchored path; no
    // qualifying fence → blanket strip (old behavior).
    //
    // Regions come from LINE-WISE fence pairing, never a regex sweep. The
    // 20261007 greedy arm (first opener → LAST closer) is exactly a wrapping
    // fence's span — but only when the LAST closer belongs to the wrapper: a
    // response whose header fence closes properly and is FOLLOWED by an
    // independent sibling fence got glued — bare ``` lines, the prose between
    // and the whole sibling block rode INTO the summary past the header check
    // (review_20261008 中3). Pairing walks the shapes these responses take:
    // inside an open fence an INFO-carrying marker (```bash …) opens a NESTED
    // level whose lines — markers included — stay verbatim in the wrapper's
    // body (review_20261007 中2), while a bare same-char marker closes the
    // innermost level. A closed header fence + sibling block therefore yields
    // TWO top-level regions and only the header one is the summary; a wrapper
    // quoting snippets yields ONE; lead-in/trailer prose lives outside every
    // region. An unclosed fence yields no region and falls through to the
    // anchored/blanket fallbacks, as before.
    const regions: string[] = []
    const open: { ch: string; len: number }[] = []
    let buf: string[] = []
    for (const line of cleaned.split('\n')) {
      if (open.length > 0) {
        const top = open[open.length - 1]
        if (new RegExp(`^ {0,3}\\${top.ch}{${top.len},}[ \t]*$`).test(line)) {
          open.pop()
          if (open.length === 0) {
            regions.push(buf.join('\n'))
            buf = []
          } else {
            buf.push(line) // an inner level's closer is body text of its wrapper
          }
          continue
        }
        const nested = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
        if (nested && !(nested[1][0] === '`' && nested[2].includes('`'))) {
          open.push({ ch: nested[1][0], len: nested[1].length })
        }
        buf.push(line)
        continue
      }
      const openM = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (openM && !(openM[1][0] === '`' && openM[2].includes('`'))) {
        open.push({ ch: openM[1][0], len: openM[1].length })
      }
    }
    const withHeader = regions.find((b) => b.includes('【用户诉求与决策】'))
    const anchored = cleaned.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
    if (withHeader) cleaned = withHeader
    else if (anchored) cleaned = anchored[1]
    else cleaned = cleaned.replace(/```[\s\S]*?(?:```|$)/g, '')
    cleaned = cleaned.trim()
    cleaned = cleaned.replace(/^(?:摘要(?:为|是)?|总结(?:为|是)?|历史摘要)[:：]?\s*/i, '').trim()
    // A fragment too short to hold the three fixed sections (the headers alone
    // are 24+ chars) and carrying none of them is not a summary — it is what
    // survives when the fence handling above could not rescue the body. THROW
    // rather than return '': OneShotAgent retries a thrown parse (its catch →
    // attempt 2), but a returned value is passed through untouched — the
    // promised "one-shot retry re-asks" never ran and the region fell to plain
    // truncation with zero compensation (review_20261007 中3). Only a second
    // failure lands in getDefaultOutput('').
    if (cleaned.length < 20 && !cleaned.includes('【用户诉求与决策】')) {
      throw new Error(`[${this.name}] summary parse produced no structured body (${cleaned.length} chars) — re-asking`)
    }
    return cleaned.slice(0, 2000)
  }

  protected getDefaultOutput(): string {
    // Empty → AgentEngine falls back to plain truncation (current behavior).
    return ''
  }
}
