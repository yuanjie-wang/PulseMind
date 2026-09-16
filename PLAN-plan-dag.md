# PulseMind Plan —— 计划模式 DAG 重构（PLAN-plan-dag）

> **目标**：把线性 Plan（`steps[]` + `currentStepIndex` 单游标）重构为 DAG（节点 + 依赖边），让计划成为多专家并行的编排骨架：无未完成依赖的节点构成「就绪集」，主代理把就绪集并行派发给 spawn_agent（M1 已支持批内并行），全部节点终态时计划收口。
> **动机**：`currentStepIndex` 游标语义下步骤天然串行——步骤 N+1 必须等 N——与引擎已有的并行 spawn 能力脱节；且 `advance_plan` 无节点标识，多个专家并行时游标语义直接崩溃（两个专家各自完成各自的步骤，"当前步"不存在）。
> **范围裁定**：本期做**协议 + 状态机 + 提示词 + 分层 UI** 的完整重构；不做节点级自动状态回写（spawn_agent 不绑定 planNodeId）、不做拖拽编辑、不画真图（零新依赖）。
> **决策确认（2026-09-16 用户逐项裁定）**：D6 = 模型自主派发；D4 = 失败不级联、模型决定重试/跳过；D9 = 拓扑分层列表；并行专家数**不设限**（撞 provider 限流再加闸，已有重试兜底）。
> **执行方式**：逐任务执行，每任务完成后跑 `npm test` + `npx tsc -p tsconfig.web.json --noEmit` + `npx tsc -p tsconfig.node.json --noEmit` 对基线只升不降，并在本文档勾选。全程遵守 AGENTS.md。

---

## 一、现状盘点

| 部件 | 位置 | 现状 |
|------|------|------|
| 类型 | `src/renderer/src/types/agent.ts` | `Plan { objective, steps: PlanStep[], currentStepIndex, completed, mode }`；`PlanStep { description, status, msgId }` |
| 状态机 | `src/renderer/src/agent/plan-manager.ts` | `execCreatePlan`（objective + steps[]，硬编码 `mode: 'delegated'`）；`execAdvancePlan`（`complete`/`fail`/`finish`，操作隐含的"当前步"） |
| 工具 schema | `src/renderer/src/tools/built-in-tools.ts:585` | `create_plan { objective, steps: string[] }`；`advance_plan { action, notes }`（无节点标识） |
| 提示词 | `system-prompt-builder.ts` `buildPlanSection` | state block 里的 `## Current Plan` 段（缓存契约安全：state block 是每请求最后一条消息，plan 随便变都不伤缓存） |
| 持久化 | `conversation.db.ts` `plan_json` 列 | 引擎 `loadPlan`/`savePlan` 全量 JSON 读写，无 schema 约束 |
| UI | `components/layout/PlanPanel.tsx` | 线性 checklist，`currentStepIndex` 高亮当前步，点击节点跳转 `msgId` |
| LLM 快照 | `plan-manager.ts` `formatPlanSnapshot` | 工具结果文本：`[done]/[fail]/[ ]` 平铺清单 |

结构性问题：① 单游标强制串行；② advance 无节点标识；③ `in_progress` 状态定义了但从未使用；④ `mode: 'direct'` 从未真正分流（create 硬编码 delegated）；⑤ 失败无「下游被阻塞」概念。

## 二、已定决策

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | ready 状态存还是派生 | **派生不存储**。`PlanNode.status` 只存 `pending / completed / failed / skipped` 四态；`readyNodes(plan)` 是纯函数（pending 且全部依赖 completed）。单一事实源，不存在存储与派生打架 |
| D2 | 不引入 running 状态 | v1 的 `in_progress` 从未被使用。DAG 版 spawn 在飞的节点不标 running（引擎不知道哪个 spawn 对应哪个节点，见 D7），**就绪集高亮就是"当前正在做"**。状态机四态，UI/快照/迁移全部简化 |
| D3 | 依赖引用的协议形式 | `depends_on` 用 **1-based 数组下标**（`[1, 3]` 指 steps[0] 和 steps[2]），executor 内部转 `n1`/`n3`。模型填下标远比发明 id 不易错 |
| D4 | 失败传播 | **不自动级联**。节点 fail 后下游保持 pending（UI 灰显 + 快照标注 blocked），由主代理决定重试（需要先造新节点？不——直接允许对 failed 节点再次 complete 即重试）或 `skip`。skip = 该节点标 skipped，下游依赖重算：依赖 failed/skipped 的 pending 节点为 blocked，依赖全终态且无 failed 的才 ready |
| D5 | advance_plan 的节点参数 | `node` **必填**（1-based 序号，兼容 `3`/`"3"`/`"n3"` 三种写法）；省略时若就绪集恰有一个节点则自动指它（弱模型兜底），多个就绪时报错并列出就绪集 |
| D6 | 编排驱动方 | **模型驱动，引擎不自动 fan-out**。引擎只提供状态机 + 快照文案（就绪集/阻塞集），主代理模型自己决定就绪节点怎么 spawn（一次回复多个 spawn_agent，M1 已并行）。模型保留合并/拆分/选专家的判断权 |
| D7 | spawn_agent 与节点的绑定 | **本期不做结构化绑定**（不加 planNodeId 参数）。plan 状态变更的唯一写者是主代理的 advance_plan 调用（**单写者原则**），杜绝子代理并发写计划的整类竞态。二期若做自动状态，给 SpawnSubAgentConfig 加可选 sourceNodeId 即可 |
| D8 | create_plan schema 兼容 | `steps` 元素从 string 升级为 `{ description, depends_on?, assignee? }`；**executor 兼容旧 string[]**（内部包装成单链 DAG）兜底弱模型。工具 schema 直接换，create_plan 只在新建计划时调用，无存量调用方兼容负担 |
| D9 | UI 形态 | **拓扑分层列表**（按最长依赖路径分层：第 1 波 / 第 2 波…层内并排），不画真图、零新依赖。380px 侧栏宽度下分层列表可读性最好；真图视图二期另立项 |
| D10 | 类型归属 | `Plan`/`PlanNode` 移到 `src/shared/types/plan.ts`，plan-graph 纯函数放 `src/shared/plan/graph.ts`——shared 代码不得反向 import renderer，且 extension panel 的 reducer（`shared/agent-session`）未来可复用；renderer/types/agent.ts re-export 保持兼容 |

## 三、设计

### 1. 数据模型（`src/shared/types/plan.ts`，新文件）

```typescript
export interface PlanNode {
  id: string                    // 'n1'..'n20'，按输入序分配，协议稳定标识
  description: string
  status: 'pending' | 'completed' | 'failed' | 'skipped'
  dependsOn: string[]           // 前置节点 id（内部表示；协议层是 1-based 下标）
  assignee?: string             // 专家 id（spawn_agent 的 subAgentId）；undefined = 通用子代理
  msgId?: string                // 完成时的跳转锚点（沿用现语义）
  summary?: string              // advance_plan notes 落这里，快照与 UI 悬浮可见
}

export interface Plan {
  objective: string
  nodes: PlanNode[]
  completed: boolean
  version: 2                    // 迁移判别：旧 JSON 无此字段
  mode?: 'direct' | 'delegated' // 语义升级：就绪集是 spawn 给专家（delegated，默认）还是主代理逐节点自干（direct）
}
```

去掉 `steps`/`currentStepIndex`。DAG 只读遍历，20 节点规模不存反向边，需要时现算。

### 2. 图操作纯函数（`src/shared/plan/graph.ts`，新文件，全覆盖单测）

```typescript
createPlanDag(objective, raw: RawNode[], mode?): Plan       // id 分配、下标→id、校验（空/≤20/引用存在/无自环/无环——Kahn 拓扑排序抛错）
readyNodes(plan): PlanNode[]                                 // pending 且 dependsOn 全 completed
blockedNodes(plan): PlanNode[]                               // pending 且 dependsOn 含 failed/skipped
markNode(plan, ref, status, msgId?, summary?): void          // 原地变更（引擎内部模式，配 notify）；complete 后若全部终态则置 plan.completed
isTerminal(status): boolean
migrateLinearPlan(old): Plan                                 // 旧结构 → 单链 n1←n2←…←nk，status 原样保留，version: 2
formatPlanForPrompt(plan): string                            // 提示词段（从 buildPlanSection 抽出）
formatPlanSnapshot(plan, { action, ref, notes }): string     // 工具结果快照（从 PlanManager 抽出）
```

### 3. 工具协议（`built-in-tools.ts`）

**create_plan v2**：

```json
{
  "objective": "string",
  "steps": [
    { "description": "string",
      "depends_on": "[1-based 下标，省略 = 无前置]",
      "assignee": "专家 id，可选" }
  ]
}
```

**advance_plan v2**：`{ action: 'complete' | 'fail' | 'skip' | 'finish', node: "序号", notes? }`

- `skip` 为新增动作（D4）。
- `complete` 语义升级：对 failed 节点再次 complete 即**重试**。
- `node` 解析规则见 D5；`finish` 不变（全部 pending → completed，收口）。

### 4. PlanManager 重构（`plan-manager.ts`）

- `execCreatePlan`：输入规范化（string[] → 单链 / object[] → createPlanDag）→ 快照文案升级为 DAG 视图，**明确列出就绪集**（delegated 模式附一句：「就绪节点相互独立，可在同一条回复里并行 spawn_agent」）。
- `execAdvancePlan`：markNode → 快照输出三段：就绪集（可开工）、阻塞集（等谁）、终态统计；计划收口时说「计划完成」。
- 构造器签名与 engine 接线**不变**（AgentEngine 构造处零改动）；msgId 锚定逻辑原样保留（complete/skip 时从 getMessages 找到本工具调用所在 assistant 消息）。

### 5. 提示词（`buildPlanSection`，state block 内，缓存契约不动）

```
## Current Plan
Objective: "…"
Mode: delegated
[x] n1 拆解需求            (completed)
[•] n2 竞品调研            (ready — 可开工)
[•] n3 技术选型            (ready — 可开工, depends: n1 ✓)
[ ] n4 汇总报告            (blocked — waiting: n2, n3)
1. 就绪节点相互独立：把每个节点派给它的 assignee 专家（spawn_agent subAgentId=…），多个 spawn_agent 放在同一条回复里并行派发。
2. 每个节点完成后必须 advance_plan action="complete" node=<序号>——计划不会自动推进。
```

这是 M2「让模型知道可以并行派发」的落地点：并行指引直接写进 plan 段，随就绪集一起出现在 state block 和工具快照里。

### 6. UI（`PlanPanel.tsx`，D9）

- 按**拓扑层**分组渲染（`layer(n) = 1 + max(layer(deps))`）：层头「第 N 波 · 可并行 M 项」，层内节点行。
- 状态图标沿用现有四枚；就绪集用当前步的高亮色，blocked 灰显 + 「等待 n2」；`summary` 做成悬浮提示。
- 节点点击 `onJumpToStep(msgId)`、折叠、分页逻辑原样保留；`displayPlan` 适配新类型。

### 7. 持久化与迁移

- `plan_json` 列与 `saveConversationPlan`/`getConversationPlan` 不动。
- `loadPlan`：`JSON.parse` 后无 `version` 字段 → `migrateLinearPlan`（无损：旧计划的完成进度是单链前缀）。
- SQLite 无 schema 变更；extension panel 不读 plan，无协议面影响。

### 8. 测试

- `tests/plan-graph.test.ts`（新）：create 校验矩阵（空/超限/坏下标/自环/成环）、ready/blocked 派生、mark 状态机（含 failed→complete 重试、skip 后下游解锁）、迁移、两份格式化文本。
- `tests/plan-manager-executors.test.ts`（新，mock 回调）：string[] 兼容链、node 三种写法解析、唯一就绪兜底、多就绪报错、快照含就绪集、msgId 锚定。
- 回归：`engine-node.test.ts`、`expert-capability-whitelist.test.ts`、`parallel-spawn-dispatch.test.ts` 全绿。

## 四、里程碑

- [x] **P1** `shared/types/plan.ts` + `shared/plan/graph.ts` 全部纯函数 + plan-graph 测试（核心，零依赖，先行）
- [x] **P2** renderer 类型 re-export + PlanManager 两个 executor + 工具 schema v2 + 快照文案（D8/D5 兜底路径齐活）
- [x] **P3** `buildPlanSection` 提示词升级（并行指引落地——M2 在此收口）
- [x] **P4** PlanPanel 分层渲染（D9）
- [x] **P5** loadPlan 迁移 + 全量回归 + tsc 双基线
