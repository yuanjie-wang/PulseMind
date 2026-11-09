// PLAN-workflow-engine：工作流存储（一 workflow 一 JSON 文件，routines 同款
// 形态）+ 内置模板播种。
//
// 校验门「三处同一」：save / 启动 / 助手应用全部先过 validateWorkflow——
// 本 store 的 save 是其中一处（启动与助手在各自模块再调同一函数）。
// 模板播种纪律对齐 copyTemplatesToDataDir 的 never-overwrite：盘上已有同名
// 文件绝不覆盖（用户的编辑是用户内容，fail-safe 方向）。

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './index'
import { normalizeBatchConfig, normalizeTriggers } from './task-config-normalize'
import { validateWorkflow, type WorkflowValidation } from '../../shared/workflow/validate'
import type { WorkflowDefinition } from '../../shared/workflow/types'

export const WORKFLOWS_DIR = join(DATA_DIR, 'workflows')

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

function workflowPath(id: string): string {
  return join(WORKFLOWS_DIR, `${id}.json`)
}

/** 读单个文件并做结构 + artifacts 路径校验；损坏/非法文件跳过（读面宽容，
 *  一个坏文件不得拖死整个列表）。 */
function readWorkflow(id: string): WorkflowDefinition | null {
  try {
    const parsed = JSON.parse(readFileSync(workflowPath(id), 'utf-8')) as WorkflowDefinition
    if (!parsed || typeof parsed !== 'object' || parsed.id !== id) return null
    if (!validateWorkflow(parsed).ok) return null
    return parsed
  } catch {
    return null
  }
}

/** save / 启动 / 助手应用三处同一校验门的存储侧实现。非法即抛——错误文案
 *  逐条透出给编辑器的内联标红与启动表单。artifacts 路径门在契约解析侧生效
 *  （shared/workflow/contract 的 artifactPathError，引擎结算时逐条过门）。 */
export function assertWorkflowValid(def: WorkflowDefinition): WorkflowValidation {
  return validateWorkflow(def)
}

export const workflowStore = {
  list(): WorkflowDefinition[] {
    if (!existsSync(WORKFLOWS_DIR)) return []
    const out: WorkflowDefinition[] = []
    for (const file of readdirSync(WORKFLOWS_DIR)) {
      if (!file.endsWith('.json')) continue
      const wf = readWorkflow(file.slice(0, -'.json'.length))
      if (wf) out.push(wf)
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  },

  get(id: string): WorkflowDefinition | null {
    if (!ID_RE.test(id)) return null
    return readWorkflow(id)
  },

  /** 新建/整体保存。id 由调用方给（模板复制起稿或既有 id）；创建时 id 冲突
   *  即拒（编辑走 save 覆盖自己的 id）。
   *
   *  写门归一与对话式任务同源（task-config-normalize）：triggers 走同一套
   *  不变量（webhook token 只能在这里铸、debounce 夹 1–60s、路径 trim），
   *  batch 存同一份 RoutineBatchConfig 形态。归一在写盘前做，任何保存路径
   *  （向导 / 助手应用 / 模板复制）都拿到同样的门。 */
  save(def: WorkflowDefinition): WorkflowDefinition {
    const normalized: WorkflowDefinition = {
      ...def,
      batch: normalizeBatchConfig(def.batch),
      triggers: normalizeTriggers(def.triggers),
    }
    if (normalized.batch === undefined) delete normalized.batch
    if (normalized.triggers === undefined) delete normalized.triggers
    const v = assertWorkflowValid(normalized)
    if (!v.ok) throw new Error(v.errors.join('；'))
    mkdirSync(WORKFLOWS_DIR, { recursive: true })
    writeFileSync(workflowPath(normalized.id), JSON.stringify(normalized, null, 2), 'utf-8')
    return normalized
  },

  remove(id: string): void {
    // 名字消毒（full_20261011 M9-P0-1 的 routine 教训）：`.json` 后缀让穿越
    // 更好用，id 必须过 ID_RE 才允许拼路径。
    if (!ID_RE.test(id)) throw new Error(`非法工作流 id：${id}`)
    const p = workflowPath(id)
    if (existsSync(p)) unlinkSync(p)
  },
}

// ── 内置模板（内置 2 模板：coding-pipeline + doc-translate-pipeline）──
// prompt 里的契约行形态与 shared/workflow/contract 的 formatPipelineResult
// 一字不差——模型照抄这个形态报 verdict。

export const WORKFLOW_TEMPLATES: WorkflowDefinition[] = [
  {
    id: 'coding-pipeline',
    name: '编码流水线',
    objective: '把 PLAN 文件中的条目高质量落地并通过全部测试与 review',
    entry: 'code',
    params: { stageTimeoutMinutes: 30, maxStageContinues: 2, defaultMaxVisits: 3, gitCheckpoint: true },
    nodes: [
      {
        id: 'code',
        title: '编码',
        verdicts: ['pass', 'fail', 'blocked'],
        // 状态定义是必填的（user 2026-11-09）：模板本身必须过保存门，否则
        // 用户打开模板、改一个字就再也存不下去。文案与下面 prompt 里的
        // 「- pass = … ; fail = … ; blocked = …」逐条同义。
        verdictDefs: {
          pass: '计划条目已实现且自检通过',
          fail: '实现受阻于具体错误（编译/运行/逻辑）',
          blocked: '缺外部条件（凭据/环境），需写明缺什么',
        },
        prompt: `你是编码阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：读取 {{planPath}} 中的计划，把其中的条目落地为代码改动。计划内容如下：

{{planContent}}

上一阶段结论：{{prevVerdict}} / {{prevSummary}}

要求：
1. 只做计划内的事；每个文件改动前必须先 read。
2. 完成后自检一遍改动面（编译器/lint 能查出的低级错误不留到测试阶段）。
3. 结束时在最后一条消息输出且仅输出一行契约（verdict 只能是 pass/fail/blocked 之一）：
PIPELINE_RESULT: {"verdict":"pass","summary":"<一句话总结>","artifacts":[]}
- pass = 计划条目已实现且自检通过；fail = 实现受阻于具体错误；blocked = 缺外部条件（凭据/环境），写明缺什么。`,
      },
      {
        id: 'test',
        title: '测试',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '测试/验证命令全部通过',
          fail: '存在失败项，失败清单已写入交付物',
        },
        prompt: `你是测试阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：在工作区运行项目的测试/验证命令，判定上一阶段（{{prevVerdict}}）的改动是否真的可用——「编辑成功 ≠ 改动生效」，必须以真实命令输出为准。计划上下文：

{{planContent}}

上一阶段交付物：

{{prevArtifacts}}

要求：
1. 优先项目自带的 test/build/verify 命令；没有就写最小可运行验证脚本（放 pipeline/ 目录下）。
2. 失败时把失败清单逐条写入 pipeline/test-failures.md（含期望/实际/相关文件行号），作为交付物传给修复阶段。
3. 结束时输出契约行（verdict 只能是 pass/fail）：
PIPELINE_RESULT: {"verdict":"pass","summary":"<命令与结果>","artifacts":["pipeline/test-failures.md"]}
- 失败清单文件即使没有失败也可以不列；有失败必须列。`,
      },
      {
        id: 'review',
        title: '评审',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '评审未发现问题',
          fail: '评审发现问题，清单已写入交付物',
        },
        prompt: `你是评审阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：对照计划评审本次全部改动（git diff 可用）：正确性、边界、与既有约定的冲突。计划：

{{planContent}}

要求：
1. 发现的问题逐条写入 pipeline/review-findings.md（严重级/文件/建议）。
2. 无问题 = pass；有问题 = fail（修复阶段会拿你的清单）。
3. 结束时输出契约行：
PIPELINE_RESULT: {"verdict":"pass","summary":"<评审结论>","artifacts":["pipeline/review-findings.md"]}`,
      },
      {
        id: 'fix',
        title: '修复',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '清单上的问题全部修复并自验通过',
          fail: '仍有问题未修复或自验未通过',
        },
        prompt: `你是修复阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：根据上一阶段（{{prevVerdict}}）的清单修复问题，不扩大改动面。清单与上下文：

{{prevArtifacts}}

{{planContent}}

要求：
1. 只修清单上的问题；修完逐条自验（能跑命令的必须跑）。
2. 结束时输出契约行（verdict 只能是 pass/fail）：
PIPELINE_RESULT: {"verdict":"pass","summary":"<修了什么>","artifacts":[]}`,
      },
    ],
    edges: [
      { from: 'code', when: 'pass', to: 'test' },
      // code 的 fail 无出边 = 默认 FAILED（fail-safe）：激发臂先续命，耗尽仍 fail 即实例失败
      { from: 'code', when: 'blocked', to: 'FAILED' },
      { from: 'test', when: 'pass', to: 'review' },
      { from: 'test', when: 'fail', to: 'fix' },
      { from: 'review', when: 'pass', to: 'DONE' },
      { from: 'review', when: 'fail', to: 'fix' },
      { from: 'fix', when: 'pass', to: 'test' },
      { from: 'fix', when: 'fail', to: 'test' },
    ],
  },
  {
    id: 'doc-translate-pipeline',
    name: '文档翻译流水线',
    entry: 'translate',
    params: { stageTimeoutMinutes: 30, maxStageContinues: 2, defaultMaxVisits: 3, gitCheckpoint: false },
    nodes: [
      {
        id: 'translate',
        title: '翻译',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '源文档已完整翻译并写入译文文件',
          fail: '翻译未完成，或存在漏段/术语错误',
        },
        prompt: `你是翻译阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：把 {{planPath}} 指定的源文档完整翻译为目标语言（计划文件里写明目标语言与术语表）。计划：

{{planContent}}

要求：
1. 译文写入源文件同目录的 <原名>.translated.md；术语表优先。
2. 结束时输出契约行（verdict 只能是 pass/fail）：
PIPELINE_RESULT: {"verdict":"pass","summary":"<翻译了什么>","artifacts":["<译文相对路径>"]}`,
      },
      {
        id: 'proofread',
        title: '校对',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '未发现漏段、术语或保真问题',
          fail: '发现问题并已写入校对记录',
        },
        prompt: `你是校对阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：对照源文档校对译文：漏段、术语不一致、数字/代码块/链接保真。上一阶段交付物：

{{prevArtifacts}}

发现的问题逐条写入 pipeline/proof-notes.md。结束时输出契约行：
PIPELINE_RESULT: {"verdict":"pass","summary":"<校对结论>","artifacts":["pipeline/proof-notes.md"]}`,
      },
      {
        id: 'finalize',
        title: '终审',
        verdicts: ['pass', 'fail'],
        verdictDefs: {
          pass: '终稿已按校对意见修订并覆盖写回译文文件',
          fail: '终稿未能完成修订',
        },
        prompt: `你是终审阶段的执行者。全局目标：{{objective}}

工作区：{{workspace}}（第 {{visit}} 次进入本阶段）

任务：按校对意见（{{prevSummary}}）修订译文终稿，覆盖写回译文文件。上一阶段交付物：

{{prevArtifacts}}

结束时输出契约行：
PIPELINE_RESULT: {"verdict":"pass","summary":"<终稿位置>","artifacts":["<译文相对路径>"]}`,
      },
    ],
    edges: [
      { from: 'translate', when: 'pass', to: 'proofread' },
      { from: 'proofread', when: 'pass', to: 'DONE' },
      { from: 'proofread', when: 'fail', to: 'finalize' },
      { from: 'finalize', when: 'pass', to: 'DONE' },
      { from: 'finalize', when: 'fail', to: 'FAILED' },
    ],
  },
]

/** 启动期播种：never-overwrite——盘上已有同名文件绝不覆盖（用户内容优先；
 *  模板升级换代不追写已装机器，与 copyTemplatesToDataDir 同一裁定方向）。 */
export function seedWorkflowTemplates(): void {
  mkdirSync(WORKFLOWS_DIR, { recursive: true })
  for (const tpl of WORKFLOW_TEMPLATES) {
    const p = workflowPath(tpl.id)
    if (existsSync(p)) continue
    try {
      writeFileSync(p, JSON.stringify(tpl, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[workflow-store] template seed failed:', tpl.id, err)
    }
  }
}
