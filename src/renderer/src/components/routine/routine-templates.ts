// ── Recommended routine templates ──
// The 推荐模板 half of the routines landing page: five workplace tasks a user
// can start from instead of a blank form. Pure data plus the one pure function
// that turns a template into an editor draft, so the contract — five entries,
// valid crons, localized copy, prompts that only lean on what a routine run can
// actually do — is testable without React (tests/routine-templates.test.ts).
//
// A template is a STARTING POINT, never a stored routine: clicking one opens the
// editor prefilled, and nothing exists until the user saves. Two consequences:
// every entry carries a complete, self-sufficient prompt, and the copy lives
// here rather than in i18n/locales — name, description and prompt are one unit
// that must not drift apart, and a prompt is content (it becomes the routine's
// own body), not chrome.
//
// Only tools a routine run really has are referenced: file reads/writes inside
// the workspace plus knowledge/memory lookups. A run is unattended, so anything
// outside the workspace is auto-rejected (D13) — a template that needed the web
// or a shell would fail every time it fired.

import type { Locale } from '../../i18n'
import type { RoutineParam } from '../../../../shared/types/routine'
import { EMPTY_DRAFT, draftScheduleFromCron } from './routine-form-model'
import type { RoutineDraftState } from './routine-form-model'

/** A template param before it is narrowed into a `RoutineParam` (whose label is
 *  a single string — the draft is locale-free, so the localization is resolved
 *  at the moment the template is applied). */
interface TemplateParam {
  key: string
  label: Record<Locale, string>
  required?: boolean
  default?: string
}

export interface RoutineTemplate {
  id: string
  name: Record<Locale, string>
  description: Record<Locale, string>
  /** The routine's body; `{{param}}` placeholders are filled at run time
   *  (renderRoutinePrompt in main/routine/routine-runner.ts). */
  prompt: Record<Locale, string>
  /** 5-field cron. Absent = a manual template (no schedule). */
  cron?: string
  params?: TemplateParam[]
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'daily-report',
    cron: '0 18 * * *',
    name: { zh: '每日工作日报', en: 'Daily work log' },
    description: {
      zh: '下班前把今天的工作整理成日报：完成、进行中、明日计划、风险待办。',
      en: 'Turn the day’s work into a log before you leave: done, in progress, tomorrow, risks.',
    },
    prompt: {
      zh: [
        '生成今天的工作日报。',
        '',
        '先查看工作区里今天的记录（当天新增或修改的文件、笔记、待办清单等），再结合可查到的上下文整理，输出四段：',
        '1. 今日完成',
        '2. 进行中',
        '3. 明日计划',
        '4. 风险与待办',
        '',
        '要求：只写有依据的内容，不要编造；每条一句话，能给数字的地方给数字。',
        '把结果保存到工作区，文件名 worklog-YYYY-MM-DD.md（用今天的日期），并在回复里给出日报正文。',
      ].join('\n'),
      en: [
        'Produce today’s work log.',
        '',
        'Start from today’s traces in the workspace (files and notes created or changed today, the todo list), add whatever context you can find, and write four sections:',
        '1. Done today',
        '2. In progress',
        '3. Tomorrow’s plan',
        '4. Risks and follow-ups',
        '',
        'Rules: write only what the evidence supports, invent nothing, one line per item, numbers where numbers exist.',
        'Save it to the workspace as worklog-YYYY-MM-DD.md (today’s date) and also give the full text in your reply.',
      ].join('\n'),
    },
  },
  {
    id: 'weekly-report',
    cron: '30 17 * * 5',
    name: { zh: '每周工作周报', en: 'Weekly report' },
    description: {
      zh: '周五汇总本周产出与进展，生成可提交的周报草稿。',
      en: 'Friday roll-up of the week’s output and progress, ready to send.',
    },
    prompt: {
      zh: [
        '生成本周的工作周报。',
        '',
        '收集本周的素材：工作区里本周的日报（worklog-*.md）、本周修改过的文件、以及能查到的项目记录，然后输出三段：',
        '1. 本周成果（按事项分组，写清结果与影响）',
        '2. 问题与风险（已经在处理的写进度，还没处理的写卡点）',
        '3. 下周计划',
        '',
        '要求：不要罗列流水账，同一件事只出现一次；没有素材的部分直接写「本周无记录」，不要虚构。',
        '把结果保存到工作区，文件名 weekly-YYYY-MM-DD.md（用本周的日期），并在回复里给出周报正文。',
      ].join('\n'),
      en: [
        'Produce this week’s report.',
        '',
        'Gather the week’s material: this week’s daily logs (worklog-*.md), files changed this week and any project notes you can find, then write three sections:',
        '1. Delivered this week (grouped by topic, with outcomes and impact)',
        '2. Problems and risks (progress for the ones being handled, blockers for the rest)',
        '3. Next week’s plan',
        '',
        'Rules: no running commentary — one entry per topic; where there is no material, write “no records this week” rather than inventing any.',
        'Save it to the workspace as weekly-YYYY-MM-DD.md (this week’s date) and also give the full text in your reply.',
      ].join('\n'),
    },
  },
  {
    id: 'meeting-notes',
    name: { zh: '会议纪要整理', en: 'Meeting minutes' },
    description: {
      zh: '把会议记录或转写文本整理成结论、待办与待确认问题。',
      en: 'Turn raw meeting notes or a transcript into decisions, action items and open questions.',
    },
    params: [
      {
        key: 'notes',
        label: { zh: '会议记录（留空则读工作区里的最新记录）', en: 'Meeting notes (blank = read the newest one in the workspace)' },
        default: '',
      },
    ],
    prompt: {
      zh: [
        '把下面的会议记录整理成结构化纪要。',
        '',
        '会议记录：',
        '{{notes}}',
        '',
        '如果上面是空的，先在工作区里找最近的会议记录（例如 meetings/ 目录下最新的 .md/.txt），找不到就直接说明没有找到会议记录并结束。',
        '输出四段：会议主题 / 关键结论 / 待办事项（每条写负责人与截止时间，没有就写「待定」）/ 待确认问题。',
        '要求：只整理记录里出现过的内容，不要替与会者下结论；发言人不明确的写「会上」而不是猜一个人名。',
        '把结果保存到工作区 meetings/纪要-YYYY-MM-DD.md（用今天的日期），并在回复里给出纪要正文。',
      ].join('\n'),
      en: [
        'Turn the meeting notes below into structured minutes.',
        '',
        'Notes:',
        '{{notes}}',
        '',
        'If that is empty, look for the newest meeting notes in the workspace (e.g. the latest .md/.txt under meetings/); if there is none, say so plainly and stop.',
        'Write four sections: Topic / Key decisions / Action items (owner and due date each, “TBD” when unstated) / Open questions.',
        'Rules: organize only what the notes say — do not draw conclusions for the attendees, and write “the meeting” instead of guessing who said what.',
        'Save it to the workspace as meetings/minutes-YYYY-MM-DD.md (today’s date) and also give the full text in your reply.',
      ].join('\n'),
    },
  },
  {
    id: 'today-priorities',
    cron: '45 8 * * 1-5',
    name: { zh: '今日优先事项', en: 'Today’s priorities' },
    description: {
      zh: '上班前梳理待办与在手事项，给出今天最该做的三件事。',
      en: 'Before the day starts: today’s three most important things, from your own todo lists.',
    },
    prompt: {
      zh: [
        '梳理今天的优先事项。',
        '',
        '查看工作区里的待办与在手事项（todo 类文件、昨天的日报 worklog-*.md、最近改动的文件），然后输出：',
        '1. 今天最该做的三件事，每件写清「为什么是它」（截止时间 / 阻塞了谁 / 影响面）',
        '2. 需要今天就确认或同步的事项',
        '3. 可以往后放的事项（一句话说明放到什么时候）',
        '',
        '要求：最多三件，不要把所有待办都列一遍；信息不足就写「需要补充：<缺什么>」，不要猜。',
        '只在回复里给出结论，不要写入文件。',
      ].join('\n'),
      en: [
        'Work out today’s priorities.',
        '',
        'Read the workspace’s open items (todo-style files, yesterday’s worklog-*.md, recently changed files) and then output:',
        '1. The three things worth doing today, each with why it is first (a deadline, who is blocked, blast radius)',
        '2. Anything that has to be confirmed or synced today',
        '3. What can wait, with one line on when it should come back',
        '',
        'Rules: three items at most — not a dump of every open task; when something is missing, write “need: <what>” rather than guessing.',
        'Answer in the reply only; do not write a file.',
      ].join('\n'),
    },
  },
  {
    id: 'monthly-review',
    cron: '0 17 1 * *',
    name: { zh: '月度工作复盘', en: 'Monthly review' },
    description: {
      zh: '每月 1 日回顾上月工作，沉淀产出、问题与下月重点。',
      en: 'On the 1st: review last month’s output, lessons and next month’s focus.',
    },
    prompt: {
      zh: [
        '对上个月的工作做一次复盘。',
        '',
        '素材来自工作区：上个月的周报与日报（weekly-*.md / worklog-*.md）、上个月改动的文件、相关项目记录。输出四段：',
        '1. 目标与结果（原本要做什么，实际做到了什么）',
        '2. 主要产出',
        '3. 问题与教训（每条写清下次怎么避免）',
        '4. 下月重点（不超过三件）',
        '',
        '要求：区分「做完了」和「推进了一点」；没有素材支撑的部分标注「无记录」，不要补故事。',
        '把结果保存到工作区，文件名 review-YYYY-MM.md（用上个月的月份），并在回复里给出复盘正文。',
      ].join('\n'),
      en: [
        'Review last month’s work.',
        '',
        'Draw on the workspace: last month’s weekly and daily reports (weekly-*.md / worklog-*.md), files changed last month and related project notes. Write four sections:',
        '1. Goals and results (what was intended, what actually happened)',
        '2. Main output',
        '3. Problems and lessons (each with what to do differently)',
        '4. Next month’s focus (three items at most)',
        '',
        'Rules: separate “finished” from “advanced a little”; mark anything without evidence as “no records” instead of filling the gap with a story.',
        'Save it to the workspace as review-YYYY-MM.md (last month’s month) and also give the full text in your reply.',
      ].join('\n'),
    },
  },
]

/** The template with this id, or null (an unknown id from a stale view param
 *  must land on the plain create-new form rather than throw). */
export function routineTemplateById(id: string | undefined): RoutineTemplate | null {
  if (!id) return null
  return ROUTINE_TEMPLATES.find((t) => t.id === id) ?? null
}

/** Friendly schedule text for a template card. Derived from the cron — the one
 *  source of truth — for the shapes templates actually use (every day / every
 *  weekday / one weekday / day-of-month); anything else shows the expression
 *  rather than a guess. */
export function routineScheduleLabel(cron: string, locale: Locale): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return cron
  const [min, hour, dom, mon, dow] = fields
  const en = locale === 'en'
  // A fixed time is what makes the text worth writing: anything with a range or
  // step in the time fields (``*/30``, ``9-18``) keeps the raw expression.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron
  const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  if (mon !== '*') return cron
  if (dow === '*' && dom === '*') return en ? `Daily ${at}` : `每天 ${at}`
  if (dow === '1-5' && dom === '*') return en ? `Weekdays ${at}` : `工作日 ${at}`
  if (dom === '*' && /^[0-6]$/.test(dow)) {
    const zhWeek = ['日', '一', '二', '三', '四', '五', '六'][Number(dow)]
    const enWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(dow)]
    return en ? `Weekly · ${enWeek} ${at}` : `每周${zhWeek} ${at}`
  }
  if (dow === '*' && /^\d+$/.test(dom)) return en ? `Monthly · day ${dom} ${at}` : `每月 ${dom} 日 ${at}`
  return cron
}

/** The editor draft a template starts from: a create-new draft (no id), the
 *  template's schedule when it has one, and its params. `sourceConversationId`
 *  stays empty — a template is not derived from a conversation. */
export function draftFromTemplate(template: RoutineTemplate, locale: Locale): RoutineDraftState {
  const params: RoutineParam[] = (template.params ?? []).map((p) => ({
    key: p.key,
    label: p.label[locale] || p.label.zh,
    ...(p.required != null ? { required: p.required } : {}),
    ...(p.default != null ? { default: p.default } : {}),
  }))
  return {
    ...EMPTY_DRAFT,
    name: template.name[locale] || template.name.zh,
    description: template.description[locale] || template.description.zh,
    prompt: template.prompt[locale] || template.prompt.zh,
    scheduleEnabled: !!template.cron,
    sched: template.cron ? draftScheduleFromCron(template.cron).sched : EMPTY_DRAFT.sched,
    params,
  }
}
