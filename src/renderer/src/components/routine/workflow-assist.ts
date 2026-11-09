// ── Workflow editor's form-assist spec ──
// The workflow half of the shared form-assist protocol
// (components/form-assist): which fields the assistant may propose, the 口径
// it must follow, and how a parsed patch is sanitized/merged. Session
// mechanics live in useFormAssistSession, the view in TaskWizardPage's
// FormAssistColumn — the same column the routine editor hosts.
//
// 「表单」here is the workflow definition itself (user 2026-11-09: 「流程图和
// JSON 是可以转换，助手主要就是编辑或者生成这个 JSON」): the canvas is a pure
// projection of `WorkflowDefinition`, so the assistant speaks that same JSON —
// nodes with their verdict vocabularies, edges, entry — instead of a lossy
// third format. A proposal is an incremental patch: `nodes` upserts by id
// (untouched nodes, their 状态定义 and their canvas coordinates survive
// verbatim), `edges` is the whole transition table, `removeNodes` deletes.
// Branching and loops are therefore expressible; keeping the graph valid
// remains the write gate's job (validateWorkflow at save), not a reason to
// hide the graph from the model.

import { nodeVerdictDefs, nodeVerdicts } from '../../../../shared/workflow/simplify'
import { missingVerdictDefs } from '../../../../shared/workflow/validate'
import { placeNewNodes } from '../../../../shared/workflow/layout'
import {
  WORKFLOW_RESERVED_TARGETS,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowInputDef,
  type WorkflowNode,
} from '../../../../shared/workflow/types'
import type { ExpertProfile } from '../../../../shared/types/expert'
import type { FormAssistSpec } from '../form-assist/form-assist'

/** One proposed node. Every field is optional: on an existing id an absent
 *  field means 「保持原样」, so 「只把评审的提示词改短」 cannot silently wipe
 *  that node's 状态定义. On a new node the id must be given for edges to be
 *  able to reference it. */
export interface WorkflowAssistantNode {
  /** Existing node id (upsert), or a fresh id for a new node. */
  id?: string
  title?: string
  prompt?: string
  /** 结果状态（画布上的出口）: replaced wholesale when present. */
  verdicts?: string[]
  /** 状态名 → 什么情况下报这个状态; merged with the node's existing map. */
  verdictDefs?: Record<string, string>
  /** 非标准形态的兜底（模型常把 verdictDefs 写成数组）：`{verdict?, text}` 列表。
   *  带 verdict 的直接用它；不带 verdict 的在 apply 里按**位置**对齐活节点的
   *  词表——sanitize 阶段看不见活节点，解析只能放到那里（user 2026-11-09
   *  「让它补完成定义，然后它就啥了」：形状写错的提案曾被静默整块丢掉）。 */
  verdictDefsList?: Array<{ verdict?: string; text: string }>
}

/** What the assistant may propose — mirrors the wizard's editable fields. */
export interface WorkflowAssistantPatch {
  name?: string
  description?: string
  objective?: string
  /** 5-field cron expression; absent = leave the schedule untouched. */
  cron?: string
  inputs?: WorkflowInputDef[]
  /** 入口节点 id; invalid/absent falls back to the current entry. */
  entry?: string
  /** Incremental upserts: existing ids are patched field-by-field, unknown
   *  ids are new nodes. */
  nodes?: WorkflowAssistantNode[]
  /** The COMPLETE transition table when present (`[]` clears every line). */
  edges?: WorkflowEdge[]
  /** Node ids to delete (their edges go with them). */
  removeNodes?: string[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Non-empty trimmed string, else undefined — 「没写」and 「写了空串」are the
 *  same thing for an upsert (an empty title/prompt could not survive
 *  validateWorkflow anyway). */
function asText(value: unknown): string | undefined {
  const text = asString(value).trim()
  return text.length > 0 ? text : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** 状态定义的取值面：字符串直接用；对象则认这几个常见键（模型写成
 *  `{verdict:'pass', definition:'…'}` 这类是常态）。 */
const DEF_TEXT_KEYS = ['text', 'def', 'definition', 'description', 'desc', 'criteria']
const DEF_VERDICT_KEYS = ['verdict', 'state', 'status', 'name', 'key']

function defTextOf(value: unknown): string | undefined {
  if (typeof value === 'string') return asText(value)
  const rec = asRecord(value)
  if (!rec) return undefined
  for (const key of DEF_TEXT_KEYS) {
    const text = asText(rec[key])
    if (text) return text
  }
  return undefined
}

function defVerdictOf(rec: Record<string, unknown>): string | undefined {
  for (const key of DEF_VERDICT_KEYS) {
    const v = asText(rec[key])
    if (v) return v
  }
  return undefined
}

/** `"pass: 全部测试通过"` 这种带前缀的纯文本项（冒号/等号/中文冒号都认）。 */
const PREFIXED_DEF_RE = /^["'「]?([A-Za-z0-9_-]{1,24})["'」]?\s*[:：=]\s*([\s\S]+)$/

/** `verdictDefs` 被写成数组时的收敛（模型最常见的错形）。三种形态都只映射到
 *  「有键/无键 + 文本」：`{verdict,text}` 对象直接取、`"pass: …"` 拆前缀、
 *  纯文本项留作无键（由 apply 按位置对齐活节点词表）。**不再有「形状不对 =
 *  整块静默消失」那条路**——那曾让「补全定义」变成一次无声的空转。 */
function sanitizeVerdictDefsList(raw: unknown[]): Array<{ verdict?: string; text: string }> {
  const out: Array<{ verdict?: string; text: string }> = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (!text) continue
      const m = PREFIXED_DEF_RE.exec(text)
      if (m) out.push({ verdict: m[1], text: m[2].trim() })
      else out.push({ text })
      continue
    }
    const rec = asRecord(item)
    if (!rec) continue
    const text = defTextOf(rec)
    if (!text) continue
    const verdict = defVerdictOf(rec)
    out.push(verdict ? { verdict, text } : { text })
  }
  return out
}

function sanitizeNode(raw: unknown): WorkflowAssistantNode | undefined {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const verdicts = Array.isArray(rec.verdicts) ? [...new Set(rec.verdicts.map(asText).filter((v): v is string => !!v))] : []
  // 标准形态（对象映射）与兜底形态（数组）**都收**：值写成对象也认（取
  // text/def/definition… 那类键）。
  const verdictDefs: Record<string, string> = {}
  for (const [key, value] of Object.entries(asRecord(rec.verdictDefs) ?? {})) {
    const name = key.trim()
    const text = defTextOf(value)
    if (name && text) verdictDefs[name] = text
  }
  const verdictDefsList = Array.isArray(rec.verdictDefs) ? sanitizeVerdictDefsList(rec.verdictDefs) : []
  const node: WorkflowAssistantNode = {
    ...(asText(rec.id) ? { id: asText(rec.id)! } : {}),
    ...(asText(rec.title) ? { title: asText(rec.title)! } : {}),
    ...(asText(rec.prompt) ? { prompt: asText(rec.prompt)! } : {}),
    ...(verdicts.length > 0 ? { verdicts } : {}),
    ...(Object.keys(verdictDefs).length > 0 ? { verdictDefs } : {}),
    ...(verdictDefsList.length > 0 ? { verdictDefsList } : {}),
  }
  // 只有 id 的条目改不了任何东西（不算「可用」）；title/prompt/词表/定义任一
  // 到场才算一次真提案。
  return node.title || node.prompt || node.verdicts || node.verdictDefs || node.verdictDefsList ? node : undefined
}

function sanitizeEdges(raw: unknown[]): WorkflowEdge[] | undefined {
  const edges = raw
    .map((e) => {
      const rec = asRecord(e)
      if (!rec) return undefined
      const from = asText(rec.from)
      const when = asText(rec.when)
      const to = asText(rec.to)
      return from && when && to ? { from, when, to } : undefined
    })
    .filter((e): e is WorkflowEdge => !!e)
  // `[]` 是「清空所有连线」（显式语义，保留）；**非空但一条都不成形**则不当作
  // 清空——模型写错了形状时静默删掉用户的全部连线，比不应用更糟。
  if (edges.length === 0 && raw.length > 0) return undefined
  return edges
}

/** Sanitize a parsed proposal: known string fields survive as-is, inputs are
 *  rebuilt item-by-item (an input without a key is dropped — it could not be
 *  referenced as {{key}}), nodes likewise (an entry carrying no content is
 *  dropped so a stray `{"id":"x"}` cannot push an undo frame), and a proposal
 *  with nothing usable is null. */
export function sanitizeWorkflowPatch(parsed: Record<string, unknown> | null): WorkflowAssistantPatch | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const name = asString(parsed.name).trim()
  const description = asString(parsed.description).trim()
  const objective = asString(parsed.objective).trim()
  const cron = asString(parsed.cron).trim()
  const entry = asText(parsed.entry)
  const inputs = Array.isArray(parsed.inputs)
    ? parsed.inputs
        .filter((i) => !!i && typeof i === 'object')
        .map((i) => {
          const rec = i as unknown as Record<string, unknown>
          return {
            key: asString(rec.key),
            label: asString(rec.label),
            ...(typeof rec.required === 'boolean' ? { required: rec.required } : {}),
            ...(rec.default != null ? { default: asString(rec.default) } : {}),
            ...(typeof rec.multiline === 'boolean' ? { multiline: rec.multiline } : {}),
          }
        })
        .filter((i) => i.key !== '')
    : []
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.map(sanitizeNode).filter((n): n is WorkflowAssistantNode => !!n) : []
  const edges = Array.isArray(parsed.edges) ? sanitizeEdges(parsed.edges) : undefined
  const removeNodes = Array.isArray(parsed.removeNodes) ? [...new Set(parsed.removeNodes.map(asText).filter((v): v is string => !!v))] : []
  if (!name && !description && !objective && !cron && !entry && inputs.length === 0 && nodes.length === 0 && edges === undefined && removeNodes.length === 0)
    return null
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(objective ? { objective } : {}),
    ...(cron ? { cron } : {}),
    ...(entry ? { entry } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(edges !== undefined ? { edges } : {}),
    ...(removeNodes.length > 0 ? { removeNodes } : {}),
  }
}

/** Node ids are `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (validate.ts) — a proposed id
 *  that fails the door is discarded rather than repaired, so a bad echo falls
 *  back to a minted id instead of a workflow that will not save. Reserved
 *  targets (DONE/FAILED/RETRY) pass this regex on purpose: they must reach
 *  validateWorkflow and be rejected loudly (minting around them would turn a
 *  node the model calls 「DONE」 into a silently different graph). */
const NODE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Minted id for a proposed node with no usable id — same shape as the canvas's
 *  add-node (WorkflowCanvas.mintNodeId), so a node born on either side reads
 *  the same. */
function mintNodeId(nodes: WorkflowNode[], taken: Set<string>): string {
  let i = nodes.length + 1
  const reserved = WORKFLOW_RESERVED_TARGETS as readonly string[]
  while (taken.has(`step${i}`) || reserved.includes(`step${i}`)) i += 1
  return `step${i}`
}

/** Merge a sanitized patch into the current definition.
 *
 *  Scalars are field-level (an absent key leaves it alone — same contract as
 *  the routine assistant). The graph half is incremental: `removeNodes` deletes
 *  (cascading its lines when `edges` is not supplied), `nodes` upserts by id
 *  keeping every field the proposal did not mention, `edges` replaces the whole
 *  table. New nodes are placed next to the existing composition (placeNewNodes)
 *  — the user's hand-placed cards are never re-laid-out. */
export function applyWorkflowAssistantPatch(proposed: WorkflowAssistantPatch, current: WorkflowDefinition): WorkflowDefinition {
  const next: WorkflowDefinition = {
    ...current,
    name: proposed.name?.trim() || current.name,
    description: proposed.description ?? current.description,
    objective: proposed.objective ?? current.objective,
  }
  if (proposed.cron?.trim()) {
    next.schedule = { ...(current.schedule ?? { catchUp: 'skip' as const }), cron: proposed.cron.trim() }
  }
  if (proposed.inputs && proposed.inputs.length > 0) {
    next.inputs = proposed.inputs.map((i) => ({
      key: i.key,
      label: i.label || i.key,
      ...(i.required != null ? { required: i.required } : {}),
      ...(i.default != null ? { default: i.default } : {}),
      ...(i.multiline != null ? { multiline: i.multiline } : {}),
    }))
  }

  const removed = new Set(proposed.removeNodes ?? [])
  const proposedNodes = proposed.nodes ?? []
  const edgesGiven = proposed.edges !== undefined
  const graphTouched = removed.size > 0 || proposedNodes.length > 0 || edgesGiven
  // 只改入口（没有任何图结构变化）：校验它活着就采纳，别的一律不碰——早退
  // 分支同时挡住 `delete next.terminalLayout`（列数没变，芯片落点仍有效）。
  if (!graphTouched) {
    if (proposed.entry && current.nodes.some((n) => n.id === proposed.entry)) next.entry = proposed.entry
    return next
  }

  let nodes = removed.size > 0 ? current.nodes.filter((n) => !removed.has(n.id)) : [...current.nodes]
  // 只删节点、没给连线表 → 替用户级联掉两端连线（该节点已不存在，留着必红）。
  const edges = edgesGiven
    ? proposed.edges!.map((e) => ({ from: e.from, when: e.when, to: e.to }))
    : current.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to))

  if (proposedNodes.length > 0) {
    // byId 同时是新节点表（按序回读）与 upsert 的基线：同一条提案里重复写
    // 同一个 id = 依次叠加（后一条基于前一条的结果）。
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const order = nodes.map((n) => n.id)
    for (const proposedNode of proposedNodes) {
      const echoedId = proposedNode.id && NODE_ID_RE.test(proposedNode.id) ? proposedNode.id : ''
      const existing = echoedId ? byId.get(echoedId) : undefined
      const id = echoedId || mintNodeId(nodes, new Set(byId.keys()))
      const base: WorkflowNode = existing ?? { id, title: id, prompt: '', verdicts: [] }
      const verdicts = proposedNode.verdicts && proposedNode.verdicts.length > 0 ? nodeVerdicts({ verdicts: proposedNode.verdicts }) : nodeVerdicts(base)
      // 定义是**合并**（只改一个状态时另一个状态的说明不能丢），合并后按当前
      // 词表裁掉孤儿键——与 simplify 的归一同一份口径。
      const defsMap: Record<string, string> = { ...(base.verdictDefs ?? {}), ...(proposedNode.verdictDefs ?? {}) }
      // 数组形态兜底：显式状态名**且在当前词表里**就照用；否则按位置对齐
      // **当前词表**——「只补定义」的提案极少重复 verdicts，那正是这条兜底要接
      // 的形态。词表外的显式名也走位置兜底，是因为它多半不是状态名而是定义正文
      // 的前缀（"Pass condition: …" 会被前缀解析吃成 verdict "Pass"），照用等于
      // 把这条定义静默丢掉。
      for (const [i, item] of (proposedNode.verdictDefsList ?? []).entries()) {
        const explicit = item.verdict && verdicts.includes(item.verdict) ? item.verdict : undefined
        const key = explicit ?? verdicts[i]
        if (key) defsMap[key] = item.text
      }
      const verdictDefs = nodeVerdictDefs({ verdictDefs: defsMap }, verdicts)
      const merged: WorkflowNode = {
        ...base,
        id,
        title: proposedNode.title ?? base.title,
        prompt: proposedNode.prompt ?? base.prompt,
        verdicts,
      }
      if (verdictDefs) merged.verdictDefs = verdictDefs
      else delete merged.verdictDefs
      byId.set(id, merged)
      if (!order.includes(id)) order.push(id)
    }
    nodes = order.map((id) => byId.get(id)!)
  }

  const alive = new Set(nodes.map((n) => n.id))
  // 入口：提案给了且活着就采纳；否则保住原入口；原入口被删则回落首个节点。
  // 回落到此为止意味着「删了入口节点」不会让整份提案被拒（那是用户在做的事）。
  next.entry = proposed.entry && alive.has(proposed.entry) ? proposed.entry : alive.has(current.entry) ? current.entry : (nodes[0]?.id ?? current.entry)
  next.nodes = nodes
  next.edges = edges
  // 列数/层数可能已变，终态芯片的旧落点失效（缺席 = 派生位）。
  delete next.terminalLayout
  return placeNewNodes(next)
}

/** The definition as the trailing [当前表单] annotation — the graph itself,
 *  minus the parts that are derived or unrelated to design: `layout` /
 *  `terminalLayout` (canvas coordinates are the user's composition; ids keep
 *  them attached), `params` / `batch` / `triggers` (run settings, other steps).
 *  Everything the model needs to add a branch (verdicts, 状态定义, edges,
 *  entry) is here, so it can edit without inventing a parallel model. */
export function workflowFormSnapshot(def: WorkflowDefinition): Record<string, unknown> {
  // 「还差哪几处定义」由写门的判定现算（missingVerdictDefs）：模型不必自己
  // diff verdicts 与 verdictDefs，用户说「补全定义」时它拿到的是一张清单，
  // 而不是一个「这张图有毛病」的印象——后者会让它把补齐做成重新设计。
  const missing = missingVerdictDefs(def)
  return {
    name: def.name,
    description: def.description ?? '',
    objective: def.objective ?? '',
    cron: def.schedule?.cron ?? '',
    inputs: def.inputs ?? [],
    entry: def.entry,
    ...(missing.length > 0 ? { missingDefinitions: missing } : {}),
    nodes: (def.nodes ?? []).map((n) => ({
      id: n.id,
      title: n.title,
      prompt: n.prompt,
      verdicts: n.verdicts,
      ...(n.verdictDefs ? { verdictDefs: n.verdictDefs } : {}),
    })),
    edges: (def.edges ?? []).map((e) => ({ from: e.from, when: e.when, to: e.to })),
  }
}

export const WORKFLOW_ASSIST_SPEC: FormAssistSpec<WorkflowAssistantPatch> = {
  conversationPrefix: 'workflow',
  clientId: 'workflow-assist',
  domain: '工作流',
  domainEn: 'workflow',
  fields: [
    { key: 'name', label: '任务名称（简短）', labelEn: 'task name (short)' },
    { key: 'description', label: '一句话描述（可选）', labelEn: 'one-line description (optional)' },
    {
      key: 'objective',
      label: '全局目标——所有节点共享的一段背景说明',
      labelEn: 'global objective — one shared background note for every node',
    },
    {
      key: 'nodes',
      label:
        '节点（增量）：每项形如 {"id":"review","title":"评审","prompt":"…","verdicts":["pass","fail"],"verdictDefs":{"pass":"全部检查通过","fail":"存在必须修改的问题"}}；已有节点只写要改的字段',
      labelEn:
        'nodes (incremental): each item like {"id":"review","title":"Review","prompt":"…","verdicts":["pass","fail"],"verdictDefs":{"pass":"everything checks out","fail":"issues must be fixed"}}; for an existing node send only the fields you change',
    },
    {
      key: 'edges',
      label: '连线（整表）：每项为 {"from","when","to"}，to 可为节点 id 或 DONE，[] 表示清空',
      labelEn: 'edges (the whole table): each item {"from","when","to"}; to is a node id or DONE; [] clears all lines',
    },
    {
      key: 'removeNodes',
      label: '要删除的节点 id 列表，例如 ["old-step"]',
      labelEn: 'node ids to delete, e.g. ["old-step"]',
    },
    { key: 'entry', label: '入口节点 id（缺省 = 当前入口）', labelEn: 'entry node id (omit to keep the current one)' },
    {
      key: 'inputs',
      label: '可选输入变量列表，每项为 {"key","label","required","default","multiline"}',
      labelEn: 'optional input variable list, each item {"key","label","required","default","multiline"}',
    },
    {
      key: 'cron',
      label: '定时，5 字段标准 crontab 表达式（本地时间），不需要定时就省略',
      labelEn: 'schedule as a 5-field standard crontab expression (local time); omit when no schedule is needed',
    },
  ],
  rules: [
    '工作流是一张有向图：nodes 是任务节点，edges 是连线。同一个结果状态可以分出多条线，一个节点也可以由多个上游汇入（会等全部上游跑完）。',
    'nodes 是**增量**：改已有节点时只回传它的 id 和你要改的字段，没写的字段保持原样；不要回传你没有改动的节点。新增节点要给小写英文 id（如 draft、review），否则连线引用不到它。',
    '**只改用户点到的那一处**：用户说「补全定义」就只回 nodes:[{"id":"a","verdictDefs":{"pass":"…"}}]——这是完整合法的提案，不必重复 prompt/verdicts/title，更不要增删节点或重写 edges；说「改提示词」就只改那一个节点的 prompt。用户没要求时不要顺手优化整张图，也不要借补定义之机改流程。',
    '每个节点必须有 verdicts（结果状态，也是画布上的出口线头）：至少一个，通常 ["pass"]，需要分支时用 ["pass","fail"] 这类短名词；**每个状态都要在 verdictDefs 里写清什么情况下报这个状态**（保存时必填，不写会在错误区被点名）。verdictDefs 是**对象**（状态名 → 一句话定义），不是数组：{"pass":"全部检查通过","fail":"有必须修改的问题"}。',
    '快照里的 missingDefinitions 是保存门列出的必填缺口（[{"node":"a","verdict":"pass"}]）：用户让你补定义时逐条照着补，补完这一项就停，不要借机改别的。',
    'edges 是**整张**转移表（不是增量）：保留的连线也要一并给全，[] 表示清空所有连线。when 必须是起点节点 verdicts 里的一项；to 是节点 id 或 DONE（流程成功结束）。',
    '删节点用 removeNodes，同时把剩下的连线在 edges 里重新给全；最初的那个节点被删时记得把 entry 指到新的开头。',
    '每个节点的 prompt 必须是独立可执行的指令（脱离当前对话也能运行），写清要做的事和判断完成的标准；可以引用 {{objective}}、{{prevVerdict}}、{{prevSummary}}、{{prevArtifacts}}、{{visit}} 与任务变量 {{key}}。',
    'inputs 是运行前需要用户填写的变量：key 用英文标识符，prompt 里用 {{key}} 引用，default 是预填值。',
    'cron 是 5 字段标准 crontab 表达式（本地时间），例如每天九点是 "0 9 * * *"。',
    'name、description、objective、节点标题与内容默认用中文书写。',
    '需要用户在明确的选项之间做选择时（比如要不要定时、要不要加分支），用 ask_user 工具给出可点选的选项，不要在正文里罗列让用户打字。',
  ],
  rulesEn: [
    'A workflow is a directed graph: nodes are the task steps, edges are the lines between them. One verdict can fan out to several targets, and a node may have several upstreams (it waits for all of them).',
    'nodes are INCREMENTAL: to change an existing node send only its id plus the fields you want changed — everything you leave out stays as-is. Do not echo nodes you are not touching. Give new nodes a lowercase English id (draft, review) so edges can reference them.',
    '**Change only what was asked**: when the user says "fill in the definitions", send just nodes:[{"id":"a","verdictDefs":{"pass":"…"}}] — that is a complete, valid proposal; do not restate prompt/verdicts/title, and do not add or remove nodes or rewrite edges. When they say "shorten the review prompt", touch only that one prompt. Never take the opportunity to redesign the graph.',
    'Every node needs verdicts (its 结果状态, the outlets drawn on the canvas): at least one, usually ["pass"]; use short nouns like ["pass","fail"] when you need branching. Every verdict MUST have a verdictDefs entry saying when it applies (required on save — missing ones get flagged). verdictDefs is an OBJECT (verdict name → one-line definition), never an array: {"pass":"everything checks out","fail":"issues must be fixed"}.',
    'The snapshot\'s missingDefinitions lists the write gate\'s required gaps ([{"node":"a","verdict":"pass"}]): when the user asks you to fill definitions, fill exactly those and stop — do not change anything else.',
    'edges is the COMPLETE transition table (not a delta): include the lines you keep, and use [] to clear them all. when must be one of the source node verdicts; to is a node id or DONE (the run finished successfully).',
    'Delete nodes with removeNodes and restate the remaining lines in edges; if the first node is deleted, point entry at the new start.',
    'Every node prompt must be a standalone executable instruction (it runs outside this conversation) with a clear definition of done; it may reference {{objective}}, {{prevVerdict}}, {{prevSummary}}, {{prevArtifacts}}, {{visit}} and task variables {{key}}.',
    'inputs are variables the user fills in before a run: key is an English identifier referenced as {{key}} in prompts; default is the prefill.',
    'cron is a 5-field standard crontab expression in local time — e.g. daily at nine is "0 9 * * *".',
    "Write name, description, objective and node content in the user's language.",
    'When the user must choose between clear options (whether to schedule, whether to branch), present clickable choices with the ask_user tool instead of listing options in prose.',
  ],
  sanitizePatch: sanitizeWorkflowPatch,
}

// ── 内部专家包（D15/D16）──
// 代码常量、不进 expertStore（同 routine-assist 的构造性隐藏）；白名单必须
// 显式给数组——「缺省 = 不限制」对内部包禁用（D15）。

/** Built-in tools the assistant's session may use. ask_user only: 设计一张
 *  任务图不需要文件/shell/委派。 */
export const WORKFLOW_ASSIST_ALLOWED_TOOLS = ['ask_user']

export const WORKFLOW_ASSISTANT_PROFILE: ExpertProfile = {
  id: 'internal-workflow-assistant',
  name: '工作流设计助手',
  basePrompt:
    '你是用户的「流程设计搭子」：用户描述一件想交给 AI 跑完的事，你把它设计成一张节点图——每个节点职责单一、产出明确，节点之间的连线和结果状态决定流程怎么走。你直接编辑这份工作流定义（节点、状态、连线），画布会同步长成你写的样子。',
  methodology:
    '先弄清最终要交付什么，再倒推需要哪几个节点；节点切分按「产出物」而不是按动作数量，能一步完成就不要拆两步。只在真的需要不同处置时才给一个节点加第二个结果状态（例如评审有 pass/fail），并写清两者的判定边界。每节点的提示词写清输入、要做什么、完成标准。可变的部分（仓库名、收件人之类）声明成输入变量，不要硬编码进提示词。',
  outputSpec: '交付的内容应当完整、自洽、可直接保存；每次回复用一到三句话说明你改动了哪些节点/连线、或还需要用户补充什么。',
  constraints:
    '信息不足先问（最多两个简短问题），不凭空编造任务内容；只做设计任务相关的事，不闲聊跑题、不主动执行任务；你的结论会直接填入表单与画布（用户可以撤销），所以只写用户要的内容。',
  skillNames: [],
  mcpServerIds: [],
}
