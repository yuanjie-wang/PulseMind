// ── 工作流模板（user 2026-11-18「工作流模板」）──
// 推荐模板区的第二个分组：内置工作流的「起点」入口。与 routine 模板同一契约
// ——点击只把定义带进向导做**草稿**（换新 id、名字沿用模板名），保存后才真正
// 创建；这里不是数据源，模板本体由主进程播种（workflow-store 的
// WORKFLOW_TEMPLATES，启动时落成一份真实工作流定义）。
//
// 为什么不直接列在卡片里：播种出来的两份是**可运行的任务**（卡片 = 运行面），
// 而模板是**新建的起点**（点击 → 向导）。两者名字相同是刻意的——用户看到的是
// 「这个模板长这样」，不是另一条任务。
//
// 只放 id 与本地化文案：定义本体一律从主进程取（`pipelineWorkflows('get')`），
// 避免同一份 prompt 在渲染端与主进程各存一份、慢慢漂移。

import type { Locale } from '../../i18n'

export interface WorkflowTemplateEntry {
  /** 内置模板在工作流存储里的 id（播种后的真实定义）。 */
  id: string
  name: Record<Locale, string>
  description: Record<Locale, string>
}

export const WORKFLOW_TEMPLATE_ENTRIES: WorkflowTemplateEntry[] = [
  {
    id: 'coding-pipeline',
    name: { zh: '编码流水线', en: 'Coding pipeline' },
    description: {
      zh: '编码 → 测试 → review，失败回到修复：把 PLAN 里的条目落地成代码并自检通过。',
      en: 'Code → test → review, looping back to fixes: turn plan items into working code.',
    },
  },
  {
    id: 'doc-translate-pipeline',
    name: { zh: '文档翻译流水线', en: 'Document translation pipeline' },
    description: {
      zh: '翻译 → 校对 → 终审：长文档的多轮翻译，术语与保真问题逐条落盘。',
      en: 'Translate → proofread → finalize: long-document translation with per-item notes.',
    },
  },
]
