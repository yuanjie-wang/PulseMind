// ── Routine editor's form-assist spec ──
// The domain half of the shared form-assist protocol
// (components/form-assist): which fields the assistant may propose, the 口径
// it must follow, and how a parsed patch is sanitized. Session mechanics live
// in useFormAssistSession, merging in routine-form-model.applyAssistantPatch,
// the views in RoutineForm / RoutineEditorPage.

import type { RoutineParam } from '../../../../shared/types/routine'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { FormAssistSpec } from '../form-assist/form-assist'

/** What the assistant may propose — mirrors the form fields it can fill. */
export interface RoutineAssistantPatch {
  name?: string
  description?: string
  prompt?: string
  /** 5-field cron expression; absent = leave the schedule untouched. */
  cron?: string
  params?: RoutineParam[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Sanitize a parsed proposal: only known string fields survive, params are
 *  rebuilt item-by-item (a param without a key is dropped), and a proposal
 *  with nothing usable is null. */
export function sanitizeRoutinePatch(parsed: Record<string, unknown> | null): RoutineAssistantPatch | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const name = asString(parsed.name)
  const description = asString(parsed.description)
  const prompt = asString(parsed.prompt)
  const cron = asString(parsed.cron)
  const params = Array.isArray(parsed.params)
    ? parsed.params
        .filter((p) => !!p && typeof p === 'object')
        .map((p) => {
          const rec = p as unknown as Record<string, unknown>
          return {
            key: asString(rec.key),
            label: asString(rec.label),
            ...(typeof rec.required === 'boolean' ? { required: rec.required } : {}),
            ...(rec.default != null ? { default: asString(rec.default) } : {}),
          }
        })
        .filter((p) => p.key !== '')
    : []
  if (!name && !description && !prompt && !cron && params.length === 0) return null
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(cron ? { cron } : {}),
    ...(params.length > 0 ? { params } : {}),
  }
}

export const ROUTINE_ASSIST_SPEC: FormAssistSpec<RoutineAssistantPatch> = {
  conversationPrefix: 'routine',
  clientId: 'routine-assist',
  domain: '日常任务',
  domainEn: 'routine',
  fields: [
    { key: 'name', label: '任务名称（简短）', labelEn: 'task name (short)' },
    { key: 'description', label: '一句话描述（可选）', labelEn: 'one-line description (optional)' },
    {
      key: 'prompt',
      label: '提示词——独立可执行的指令，用 {{变量名}} 引用变量',
      labelEn: 'prompt — a standalone executable instruction; reference variables as {{var}}',
    },
    {
      key: 'cron',
      label: '定时，5 字段标准 crontab 表达式（本地时间），不需要定时就省略',
      labelEn: 'schedule as a 5-field standard crontab expression (local time); omit when no schedule is needed',
    },
    {
      key: 'params',
      label: '可选变量列表，每项为 {"key","label","required","default"}',
      labelEn: 'optional variable list, each item {"key","label","required","default"}',
    },
  ],
  rules: [
    'prompt 必须是独立可执行的指令（脱离当前对话也能运行），保留关键上下文与步骤；用 {{变量名}} 引用变量。',
    'params 里每项是一个变量：key 用英文标识符，label 是界面显示名，default 是默认值。',
    'cron 是 5 字段标准 crontab 表达式（本地时间），例如每天九点是 "0 9 * * *"。',
    'name、description、prompt 默认用中文书写。',
    '需要用户在明确的选项之间做选择时（比如定时方式、要不要变量），用 ask_user 工具给出可点选的选项，不要在正文里罗列让用户打字。',
  ],
  rulesEn: [
    'The prompt must be a standalone executable instruction (it runs outside this conversation); keep the key context and steps, and reference variables as {{var}}.',
    'Each entry in params is one variable: key is an English identifier, label is the display name and default is the default value.',
    'cron is a 5-field standard crontab expression in local time — e.g. daily at nine is "0 9 * * *".',
    "Write name, description and prompt in the user's language.",
    'When the user must choose between clear options (schedule style, whether to add a variable), present clickable choices with the ask_user tool instead of listing options in prose.',
  ],
  // Transcripts persisted before the shared protocol still propose through
  // their old fence (a full-form draft merges field-level, so it is
  // patch-compatible).
  legacyFence: 'routine-draft',
  sanitizePatch: sanitizeRoutinePatch,
}

// ── 内部专家包（D15/D16）──
// 代码常量、不进 expertStore：面板网格、召唤名册、会话绑定下拉、expertReset、
// 经验管线没有任何代码路径能看见不在 DB 里的东西——「隐藏」是构造性的。身份
// 四段式只讲领域与人设，协议（form-patch 围栏、[当前表单] 注记）归 spec 层，
// built-in 工具集归宿主 create options（D17 分工线），两边互不越界。
// 白名单必须显式给数组——「缺省 = 不限制」的语义对内部包禁用（D15）。

/** Built-in tools the assistant's session may use. ask_user only: 填表不需要
 *  文件/shell/委派；白名单钉定即隐含 MCP=0（pick_tool 被滤除，MCP 工具是激活
 *  制、永远无法激活），无需再单独关。 */
export const ROUTINE_ASSIST_ALLOWED_TOOLS = ['ask_user']

export const ROUTINE_ASSISTANT_PROFILE: ExpertProfile = {
  id: 'internal-routine-assistant',
  name: '任务创建助手',
  basePrompt: '你是用户的「自动化搭子」：用户描述一件想定期让 AI 替自己做的事，你把它设计成一条可靠、可复用的日常任务——独立可执行的提示词、合理的定时、必要的变量。',
  methodology: '先弄清做什么、什么时候做、需要什么输入，再动手；提示词必须脱离当前对话也能执行，关键上下文与步骤写全；可变的部分（仓库名、收件人之类）提成变量，不要硬编码进提示词。',
  outputSpec: '交付的内容应当完整、自洽、可直接保存；每次回复用一到三句话说明你填了什么、或还需要用户补充什么。',
  constraints: '信息不足先问（最多两个简短问题），不凭空编造任务内容；只做填表相关的事，不闲聊跑题、不主动执行任务；你的结论会直接填入表单（用户可以撤销），所以只写用户要的内容，不要一次塞满所有字段。',
  skillNames: [],
  mcpServerIds: [],
}
