// ── SOP distillation runner（PLAN-experience-sop 刀三，2026-10-26）──
// 二阶段固化：针对一阶段的经验线索页，跑一个带工具的无人值守会话——读完整源
// 会话证据（hydrateConversation 带回的 tool_results 字节），把确定性流程蒸馏成
// 脚本并实际执行验证，验证通过才以 supersede 升格 SOP 页（谱系留链）。
//
// 执行器姿态与 routine-runner 同源（unattended 事件网：审批/提问自动结、轮限/
// 暂停即结算失败、超时兜底），但不落 routine_runs/webhook——SOP 运行没有 run 行，
// 观察面 = 完成通知 + 运行转写（sop_ 前缀 → routine 型，不进聊天列表、不进
// 记忆提取清扫的候选池）。
//
// 授权用 'auto' 而非 routine 的 'outside-ask'：固化代理的职责就是运行脚本验证，
// outside-ask 会拒掉全部 exec 层调用、验证门结构性死亡。点击「固化为 SOP」本身
// 就是逐次同意；围栏是全新铸造的 scratch workspace + 沙箱 guard 的既有策略。
//
// 结果契约走文件 + 尾行 JSON（runner 落库，代理只产出交付物——代理不可信以
// memory_save 自报验证）：
//   sop/page.md          SOP 正文（验证通过后成为新页 body）
//   sop/scripts/*.mjs    ≤3 个脚本（仅 node: 内建；argv/env 参数化；幂等）
//   sop/verification.md  每个脚本两次成功运行的命令与输出尾部
//   末行 SOP_RESULT: {"verdict":"sop","title":...,"summary":...} 或 {"verdict":"clue","reason":...}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentSessionManager } from './session-manager'
import { notify } from '../routine/routine-runner'
import { saveConversation, hydrateConversation, setConversationApprovalMode, setConversationProfile } from '../storage/conversation.db'
import { resolveConversationWorkspace } from '../storage/conversation-workspace'
import { agentMessagesToConversation } from '../../renderer/src/utils/message-utils'
import { applyPageOps, getMemoryPageById, listMemoryPages, recordSopFailedAttempt } from '../storage/memory-pages-store'
import { settingsStore } from '../storage/settings-store'
import type { AgentEventData } from '../../shared/agent-protocol'
import type { AgentMessage } from '../../renderer/src/types/agent'
import { isLivePage, type MemoryPageFile } from '../../shared/memory-pages'

const SOP_RUN_TIMEOUT_MS = 20 * 60_000
/** 证据文件的整体字符帽（超出截断并显式标注——红线：不许静默截断）。 */
const EVIDENCE_BUDGET = 120_000
const TOOL_RESULT_HEAD = 1500
const MAX_SCRIPTS = 3

export interface DistillSopResult { conversationId?: string; error?: string }

/** 页 id → 运行中会话 id。二次点击必须是温和的「已在固化中」而非并跑。 */
const activeSopRuns = new Map<string, string>()

/** 自动清扫的防重入口：同页在飞时自动派发跳过（手动按钮走 distillSop 的互斥）。 */
export function isSopDistilling(pageId: string): boolean {
  return activeSopRuns.has(pageId)
}

function mintSopConvId(): string {
  return `sop_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** 源会话 → 证据文本（带完整 tool_results；每条结果只留头部）。 */
function buildEvidenceText(sourceConversationId: string): string {
  const conv = hydrateConversation(sourceConversationId, TOOL_RESULT_HEAD)
  if (!conv) return '(源会话已不可读——只依据线索正文判断。)'
  const parts: string[] = [`# Source conversation ${sourceConversationId}`]
  let total = 0
  for (const msg of conv.messages ?? []) {
    const lines: string[] = [`[${msg.role}]`]
    for (const block of msg.contentBlocks ?? []) {
      if (block.type === 'text') lines.push((block as { text: string }).text)
      else if (block.type === 'tool_use') lines.push(`(tool_use: ${(block as { name: string }).name})`)
      else if (block.type === 'tool_result') {
        const c = (block as { content?: string }).content ?? ''
        lines.push(`(tool_result${(block as { is_error?: boolean }).is_error ? ' ERROR' : ''}: ${c.slice(0, TOOL_RESULT_HEAD)})`)
      }
    }
    const chunk = lines.join('\n')
    if (total + chunk.length > EVIDENCE_BUDGET) {
      parts.push(`\n(证据在 ${EVIDENCE_BUDGET} 字符处截断——更早的轮次不可见；以现有证据为准，不要臆测被截断的部分)`)
      break
    }
    total += chunk.length
    parts.push(chunk)
  }
  return parts.join('\n\n')
}

function buildTaskPrompt(pageTitle: string, pageBody: string, sourceConversationId: string | null): string {
  return `# 任务：把下面的经验线索固化为可执行的 SOP

## 线索（记忆页：${pageTitle}）
${pageBody}

（线索正文按 SKILL 标准写成手册形态：## 适用场景 / ## 步骤 / ## 注意事项——你的 sop/page.md 要保持同一手册形态，再叠加验证证据。）

## 证据
- 完整源会话转写（含工具真实输出）：工作目录内 \`evidence/transcript.md\`${sourceConversationId ? `\n- 源会话 id：${sourceConversationId}` : ''}

## 你要做的
1. 读证据，判断这条经验里的流程是否**确定性、可脚本化**。判断性/依赖当时上下文的工作不配脚本。
2. 可以固化：
   - SOP 正文写到 \`sop/page.md\`（结构：## 前置条件 / ## 步骤 / ## 脚本说明 / ## 验证证据；用会话语言书写）；
   - 脚本写到 \`sop/scripts/\`（≤${MAX_SCRIPTS} 个，.mjs；仅 Node 20 内建模块且 \`node:\` 前缀导入；一切输入走 process.argv/env 参数化，不硬编码路径与密钥；幂等）；
   - **每个脚本在默认参数下实际运行两次，两次都必须成功**；把每次的命令与输出尾部记录到 \`sop/verification.md\`（这是验证门，缺它或为空 = 固化失败）。
3. 不可固化（信息不足/纯判断性）：不写任何脚本，直接在最终回复末尾给 clue verdict 与原因。

## 结果契约（最终回复的最后一行，严格遵守）
- 固化成功：SOP_RESULT: {"verdict":"sop","title":"<新页标题，与线索页不同名>","summary":"<一句话结论，≤50 字>"}
- 放弃固化：SOP_RESULT: {"verdict":"clue","reason":"<一句话原因>"}

注意：sop/ 下的文件是交付物本体（runner 会读取并落库），最终回复只需简短总结 + 结果行。`
}

/** 解析代理末条 assistant 消息的结果契约行（取最后一个 SOP_RESULT 行；
 *  行坏了就当没有——不做部分猜测）。 */
export function parseSopVerdict(text: string): { verdict: 'sop' | 'clue'; title?: string; summary?: string; reason?: string } | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^SOP_RESULT:\s*(\{.*\})$/)
    if (!m) continue
    try {
      const parsed = JSON.parse(m[1]) as { verdict?: string; title?: string; summary?: string; reason?: string }
      if (parsed.verdict === 'sop' || parsed.verdict === 'clue') return parsed as { verdict: 'sop' | 'clue'; title?: string; summary?: string; reason?: string }
    } catch { /* fallthrough */ }
    return null
  }
  return null
}

/** 交付物核收：文件在、验证记录非空、脚本数合法。返回 null = 核收失败。 */
function collectDeliverables(workspaceDir: string): { body: string; files: MemoryPageFile[]; verification: string } | null {
  const sopDir = join(workspaceDir, 'sop')
  const pagePath = join(sopDir, 'page.md')
  const verifyPath = join(sopDir, 'verification.md')
  const scriptsDir = join(sopDir, 'scripts')
  if (!existsSync(pagePath)) return null
  const body = readFileSync(pagePath, 'utf-8').trim()
  if (!body) return null
  const verification = existsSync(verifyPath) ? readFileSync(verifyPath, 'utf-8').trim() : ''
  if (!verification) return null // 验证门：缺记录 = 没验证
  if (!existsSync(scriptsDir)) return null
  const names = readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs') || n.endsWith('.js')).sort()
  if (names.length === 0 || names.length > MAX_SCRIPTS) return null
  const files = names.map((n) => ({ path: `scripts/${n}`, content: readFileSync(join(scriptsDir, n), 'utf-8') }))
  return { body, files, verification }
}

async function persistTranscript(convId: string, title: string): Promise<void> {
  try {
    const { messages } = await agentSessionManager.history(convId)
    if (!Array.isArray(messages) || messages.length === 0) return
    saveConversation(agentMessagesToConversation(messages as AgentMessage[], convId, title))
  } catch (err) {
    console.warn('[SopRunner] transcript persistence failed:', err)
  }
}

/** 固化结论落线索页（update op 追加「固化记录」节；页保持 clue 态，可再次尝试）。 */
function recordSettlement(pageTitle: string, note: string): void {
  const current = listMemoryPages('experience').find((p) => p.title === pageTitle && isLivePage(p))
  if (!current) return
  const stamp = new Date().toISOString().slice(0, 10)
  const body = `${current.body.trimEnd()}\n\n## 固化记录\n- ${stamp} ${note.slice(0, 220)}`
  applyPageOps([{ action: 'update', target: pageTitle, content: body }])
}

/** 刀三主入口：把一条经验线索固化为 SOP（手动按钮触发，串行，同页互斥）。 */
export async function distillSop(pageId: string): Promise<DistillSopResult> {
  const page = getMemoryPageById(pageId)
  if (!page) return { error: '经验页不存在' }
  if (page.type !== 'experience') return { error: '只支持经验页' }
  if (page.maturity !== 'clue') return { error: '该页已是 SOP' }
  if (!page.sourceConversationId) return { error: '该页没有源会话指针，无法回溯证据' }
  if (activeSopRuns.has(pageId)) return { error: '该经验已在固化中' }
  if (!page.body.trim()) return { error: '线索正文为空' }

  const settings = await settingsStore.get()
  const profile = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
  if (!profile || !profile.apiKey) return { error: '未配置模型，无法固化' }

  const convId = mintSopConvId()
  activeSopRuns.set(pageId, convId)
  void runDistill(pageId, page.title, page.body, page.sourceConversationId, convId, profile.id).finally(() => {
    activeSopRuns.delete(pageId)
  })
  return { conversationId: convId }
}

async function runDistill(
  pageId: string,
  pageTitle: string,
  pageBody: string,
  sourceConversationId: string,
  convId: string,
  profileId: string
): Promise<void> {
  let settled = false
  let stopNet: NodeJS.Timeout | undefined

  const finish = (status: 'success' | 'failed', error?: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    if (stopNet) clearTimeout(stopNet)
    unsubscribe?.()
    agentSessionManager.releaseRunPins(convId)
    // 结果回收 → 通知（先收结果再通知，通知文案带核收结论）
    void readLastAssistantText(convId)
      .then((text) => settleOutcome(pageId, pageTitle, workspaceDir, status, error, text))
      .then((note) => persistTranscript(convId, `[SOP] ${pageTitle}`).then(() => note))
      .then((note) => {
        if (note.kind === 'promoted') notify(`SOP 固化完成：${pageTitle}`, `经验已升格为 SOP 页「${note.title}」（${note.scriptCount} 个验证过的脚本）`)
        else if (note.kind === 'declined') notify(`SOP 固化结论：${pageTitle}`, `代理判断不可固化：${note.reason.slice(0, 100)}`)
        else notify(`SOP 固化未完成：${pageTitle}`, note.reason.slice(0, 120))
      })
      .catch((err) => console.warn('[SopRunner] settlement failed:', err))
  }

  // scratch workspace：该次 run 自己铸造的会话目录——证据、脚本、验证全在里面。
  const workspaceDir = await resolveConversationWorkspace(convId)
  const evidenceDir = join(workspaceDir, 'evidence')
  try {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'transcript.md'), buildEvidenceText(sourceConversationId))
  } catch (err) {
    console.warn('[SopRunner] evidence assembly failed:', err)
    return finish('failed', '证据装配失败')
  }

  const timeout = setTimeout(() => {
    void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
    finish('failed', `运行超时（${SOP_RUN_TIMEOUT_MS / 60_000} 分钟）`)
  }, SOP_RUN_TIMEOUT_MS)

  const onEvent = (sessionId: string, data: AgentEventData): void => {
    if (sessionId !== convId || settled) return
    if (data.type === 'status' && (data.status === 'awaiting_approval' || data.status === 'awaiting_user_input')) {
      // 'auto' 授权 + 无 ask_user 任务下不该出现的两态；防御网：停掉并按失败结算，绝不挂死。
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish('failed', data.status === 'awaiting_approval' ? '运行等待审批（意外）' : '运行等待用户输入（意外）')
    } else if (data.type === 'status' && (data.status === 'awaiting_extension' || data.status === 'awaiting_continue')) {
      void agentSessionManager.engineCall(convId, 'stopExecution', []).catch(() => {})
      finish('failed', '任务触及单回合轮次上限或等待决策，已停止')
    } else if (data.type === 'status' && data.status === 'completed') {
      finish('success')
    } else if (data.type === 'status' && data.status === 'error') {
      finish('failed', data.error ?? '任务执行出错')
    }
    // stopRequested 分支不需要：本 runner 无停止入口（v1 由超时/事件网兜底）
  }
  const unsubscribe = agentSessionManager.onEvent(onEvent)

  try {
    setConversationApprovalMode(convId, 'auto')
    setConversationProfile(convId, profileId)
    await agentSessionManager.createSession(convId, {
      title: `[SOP] ${pageTitle}`,
      clientId: 'routine',
      workspaceDir,
      approvalMode: 'auto',
      profileId,
    })
    await agentSessionManager.ask(convId, buildTaskPrompt(pageTitle, pageBody, sourceConversationId))
  } catch (err) {
    finish('failed', err instanceof Error ? err.message : String(err))
  }
}

type SettlementNote =
  | { kind: 'promoted'; title: string; scriptCount: number }
  | { kind: 'declined'; reason: string }
  | { kind: 'failed'; reason: string }

/** 末条 assistant 消息的文本（结果契约行的载体）。 */
async function readLastAssistantText(convId: string): Promise<string> {
  try {
    // history() 的 messages 刻意为 unknown[]（wire 层不背渲染端类型）——这里收窄到本函数用到的形状
    type HistoryMsg = { role: string; contentBlocks?: Array<{ type: string; text?: string }> }
    const { messages } = await agentSessionManager.history(convId)
    const last = ([...(messages ?? [])] as HistoryMsg[]).reverse().find((m) => m.role === 'assistant')
    return (last?.contentBlocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  } catch {
    return ''
  }
}

/** 会话落地后的核收：结果契约 + 交付物校验 → 落库。`lastAssistantText` 由调用侧
 *  从运行转写读出——本函数不碰会话管理器，probe 直驱。导出仅为探针/测试面。
 *  非升格结论（declined/failed）顺手记一次失败尝试——刀四自动清扫的退避/退役
 *  计数面；手动按钮不受此门。 */
export async function settleOutcome(
  pageId: string,
  pageTitle: string,
  workspaceDir: string,
  status: 'success' | 'failed',
  error: string | undefined,
  lastAssistantText: string
): Promise<SettlementNote> {
  const note = await settleOutcomeInner(pageId, pageTitle, workspaceDir, status, error, lastAssistantText)
  if (note.kind !== 'promoted') recordSopFailedAttempt(pageId)
  return note
}

async function settleOutcomeInner(
  pageId: string,
  pageTitle: string,
  workspaceDir: string,
  status: 'success' | 'failed',
  error: string | undefined,
  lastAssistantText: string
): Promise<SettlementNote> {
  if (status === 'failed') {
    const reason = error ?? '任务执行出错'
    recordSettlement(pageTitle, `固化失败：${reason}`)
    return { kind: 'failed', reason }
  }
  const verdict = parseSopVerdict(lastAssistantText)
  if (!verdict) {
    const reason = '代理未给出结果契约（SOP_RESULT 行缺失）'
    recordSettlement(pageTitle, `固化失败：${reason}`)
    return { kind: 'failed', reason }
  }
  if (verdict.verdict === 'clue') {
    const reason = verdict.reason?.trim() || '代理判断不可固化'
    recordSettlement(pageTitle, `判断不可固化：${reason}`)
    return { kind: 'declined', reason }
  }
  // verdict=sop：交付物核收——文件与验证记录缺一即按失败落账
  const deliverables = collectDeliverables(workspaceDir)
  if (!deliverables) {
    const reason = '交付物核收失败（缺 sop/page.md、sop/scripts 或验证记录为空）'
    recordSettlement(pageTitle, `固化失败：${reason}`)
    return { kind: 'failed', reason }
  }
  const newTitle = (verdict.title ?? '').trim() || `${pageTitle}·SOP`
  const summary = (verdict.summary ?? '').trim() || undefined
  const bodyWithVerification = `${deliverables.body.trimEnd()}\n\n## 验证证据\n${deliverables.verification.trim()}\n\n(固化于 ${new Date().toISOString().slice(0, 10)}；验证证明脚本在默认参数下自洽执行，不等于复现原任务结果。)`
  const ops = [{
    action: 'supersede' as const,
    target: pageTitle,
    title: newTitle,
    type: 'experience' as const,
    content: bodyWithVerification,
    ...(summary ? { summary: summary.slice(0, 50) } : {}),
    files: deliverables.files,
    links: [] as string[],
  }]
  const results = applyPageOps(ops)
  if (!results[0].ok) {
    recordSettlement(pageTitle, `固化失败：落库 ${results[0].error ?? ''}`)
    return { kind: 'failed', reason: `落库失败：${results[0].error ?? ''}` }
  }
  void pageId // 升格完成后旧页自动被 superseded_by 指针归档；页 id 不再单独使用
  return { kind: 'promoted', title: newTitle, scriptCount: deliverables.files.length }
}
