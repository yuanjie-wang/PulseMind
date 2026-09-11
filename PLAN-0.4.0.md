# PulseMind 0.4.0 Plan —— 信息架构重构与创意工具中心

> **目标**:把"一个对话 + 一个设置弹窗"升级为菜单驱动的工作台——新建对话/项目、日常工作(可定时)、能力中心、知识中心、工具中心(创意设计)五个一等入口,并把当前零散的能力配置收拢为可管理、可执行、可管控的模块。
> **背景**:`PLAN-0.3.5` 已完成 M1(引擎入主进程 + AgentHost 能力接口)、M2.2(会话多客户端)、M2.3(macOS 托盘常驻)、M2.4(服务设置)。引擎已可在主进程无头运行(`src/main/agent/session-manager.ts` 提供 `createSession/ask/cancel/snapshot`),这是"定时任务"与"工具运行"的前提。
> **执行方式**:逐任务执行,每任务完成后跑 `npm test` + `npx tsc -p tsconfig.web.json --noEmit` + `npx tsc -p tsconfig.node.json --noEmit` 对基线(web 25 / node 19,只降不升),并在本文档勾选。全程遵守 AGENTS.md(类 ≤1000 行、方法 ≤200 行、先检索 utils 再动手)。

---

## 一、已定决策(2026-09-11 确认,不再重开)

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 项目与会话关系 | **项目=容器,内含多个会话**,共享同一固定工作区与同一套沙箱策略 |
| D2 | 沙箱默认强度 | **`workspace-write` + `outside-ask`**;OS 级硬隔离默认关,按项目开启 |
| D3 | 日常工作与技能 | **两者分离**:技能=提示注入能力(模型按需选用);日常=用户主动触发/可定时的任务 |
| D4 | 设置入口 | **菜单底部独立项**(六个主入口下方加分隔线),与「关于」并列;打开现有设置弹窗 |
| D5 | 记忆/知识隔离 | **保持全局(v1)**:项目只隔离文件工作区与沙箱策略 |
| D6 | 工具中心定位 | **创意设计中心**:多轮对话澄清需求 → 生成 HTML 交互工具 → 持续迭代修改 |
| D7 | 自由画布 | **入口隐藏,代码保留**(不删除,标注 deprecated) |
| D8 | 定时表达式 | **引入 `cron-parser`** |
| D9 | "内置工具"含义 | **预置的示例 Web 工具**(可复制改造),非 Agent 内置工具 |
| D10 | Web 工具能力 | **网络 + 本地文件 + 系统能力**(经 bridge + 能力声明 + 审批) |
| D11 | 生成的工具可否被 agent 调用 | **仅用户使用**,不注册进 agent 工具表 |
| D12 | 工具画廊内容 | 我的工具 + 预置模板的统一画廊,带显眼的「创造」按钮 |
| D13 | 定时任务无人值守审批 | **自动拒绝并记录**:定时触发时工作区内自动放行,越界/需审批一律拒绝、记入运行历史,支持人工补跑 |
| D14 | 项目会话在主侧边栏的呈现 | **按项目分组折叠**:项目名做分组头,普通会话归「默认」组 |
| D15 | MCP/技能/子代理启用状态 | **全局共享(v1)**,不随项目隔离;项目只隔离文件工作区与沙箱策略 |
| D16 | 工具与项目的关系 | **工具全局**,默认仅读写自身目录;更广路径须经 `pickFile`/`pickDirectory` 用户当场选择(选择即授权) |
| D17 | 删除项目的会话处置 | **连带删除项目内全部会话**,弹窗列出会话数并二次确认 |
| D18 | 视觉设计参考 | **无设计稿**,按现有页面的 antd 风格/密度/配色自拟,M1 后先小样定调 |

> D11 的一个直接推论:工具中心**不需要**参数 schema / 调用契约 / `ToolManager.registerTool` 链路,工作量从"M5 脚本沙箱"整体转移到"生成 + 运行时宿主"。

---

## 二、目标信息架构

### 2.1 左上角菜单

```
┌ 菜单按钮 ──────────────────────┐
│  新建对话          ← 与现在完全一致          │
│  新建项目          ← 选固定工作区 + 沙箱策略   │
│  ──────────────────────────────│
│  日常工作          ← 可执行/可定时任务        │
│  能力中心          ← MCP / 技能 / 子代理 / 经验 │
│  知识中心          ← 与现在一致               │
│  工具中心          ← 创意设计中心(新)         │
│  ──────────────────────────────│
│  设置  ⚙            ← 打开现有设置弹窗        │
│  关于  ⓘ                                       │
└──────────────────────────────┘
```

侧边栏保留会话列表;菜单是覆盖层(Popover),不占常驻空间;左上角现有折叠按钮保留。

### 2.2 五个一级视图

```
① 新建对话 / 普通会话            ② 项目(容器)
┌──────────┬──────────────┐    ┌──────────┬────────────────────────┐
│ 会话列表  │  聊天          │    │ 项目列表  │ 项目详情                │
│          │              │    │          │ ┌ 工作区 ~/code/app     │
│          │              │    │          │ │ 沙箱 workspace-write  │
│          │              │    │          │ │ 硬隔离 关              │
│          │              │    │          │ ├──────────────────────┤
│          │              │    │          │ │ + 新建对话            │
│          │              │    │          │ │  · 修复登录 bug  2h   │
│          │              │    │          │ │  · 重构支付模块  昨天  │
└──────────┴──────────────┘    └──────────┴────────────────────────┘

③ 日常工作                      ④ 能力中心
┌─────────────────────────────┐  ┌──────────────────────────────────┐
│ [+ 新建]  [从对话提取]        │  │ [MCP] [技能] [子代理] [经验]      │
│─────────────────────────────│  │──────────────────────────────────│
│ ▸ 每日代码巡检   每天 09:00 ● │  │  (内嵌现有 MCPSettings /          │
│ ▸ 周报生成       周五 18:00 ● │  │   SkillsPanel / SubAgentSettings /│
│ ▸ 依赖升级检查   手动      ○ │  │   ExperiencePanel,逻辑不改)       │
│ 下次运行 明天 09:00           │  │                                  │
└─────────────────────────────┘  └──────────────────────────────────┘

⑤ 知识中心 = 现有 KnowledgePanel 原样搬入

⑥ 工具中心(创意设计中心)
┌───────────────────────────────────────────────────────────┐
│  工具中心                             [+ 创造工具]         │
│  [ 我的工具 ]  [ 预置模板 ]                                  │
│───────────────────────────────────────────────────────────│
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ 缩略图  │ │ 缩略图  │ │ 缩略图  │ │  +     │              │
│  │ 番茄钟  │ │ Post工具│ │ 计算器  │ │ 创造   │              │
│  │ 打开 编辑│ │ 打开 编辑│ │ 打开 编辑│ │        │              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
└───────────────────────────────────────────────────────────┘
   │ 点「创造」
   ▼
┌ 工具工作室 ────────────────────────────────────────────────┐
│ ┌ 需求澄清对话 ──────────┐ ┌ 实时预览 ───────────────────┐ │
│ │ AI: 这个工具做什么?      │ │                             │ │
│ │ 你: 帮我做个 Post 工具   │ │   (iframe 渲染 app.html     │ │
│ │ AI: 需要支持哪些方法?    │ │    + bridge 能力)           │ │
│ │ 你: GET/POST,带头部...  │ │                             │ │
│ │ AI: 确认后开始生成       │ │                             │ │
│ │ ───────────────────    │ │                             │ │
│ │ [需求确认,开始生成]      │ │                             │ │
│ └────────────────────────┘ └─────────────────────────────┘ │
│  完成后:左侧转为「继续提修改要求」的迭代对话                  │
└───────────────────────────────────────────────────────────┘
```

---

## 三、里程碑依赖图

```
M0 基线冻结 ─→ M1 导航骨架 ─┬─→ M2 能力中心(低风险,先落)
                            ├─→ M3 项目+沙箱(最大风险) ─┐
                            ├─→ M4 日常工作+定时 ────────┼─→ M7 回归收尾
                            └─→ M5 工具中心 I:创作与画廊 ─→ M6 工具中心 II:运行时能力层 ─┘
```

- M2 与 M3/M4 可并行
- M5 的生成内核复用现有 `canvasEngine`,不依赖沙箱;M6 的能力层依赖 M3 的策略模型
- M4 的定时依赖托盘常驻(macOS 已具备;win/linux 见风险 R6)

---

## M0 基线冻结与前置决策

- [x] **M0.1 迁移对象盘点与基线记录**
  - 范围:确认附录 A 对照表无遗漏;把 `npm test` 通过数与 tsc 两侧错误数写入本文件
  - **基线(2026-09-11,feature_0.4.0 起点)**:`npm test` 77 passed / 12 files;web tsc 25(=基线);node tsc 27(**存量漂移**:PLAN-0.3.5 记录 19,由 0.3.5 后期提交引入,与本 Plan 无关——0.4.0 期间以 25/27 为锚点,只降不升)
  - 验收:基线数字落纸,后续只降不升 ✓
  - 信息:`chore(plan): 0.4.0 kickoff — baseline + migration inventory`
- [x] **M0.2 依赖与能力探测**
  - **cron-parser@^4.9(CJS)**:安装并通过冒烟(`parseExpression('0 9 * * 1-5')` 下次运行计算正确;注意 v5 是纯 ESM,主进程 external require 只能配 v4)
  - **sandbox-exec(darwin 24,macOS 15)**:`/usr/bin/sandbox-exec` 可用,`deny file-write*` 生效,`allow file-write* (subpath ...)` 正向放行生效 ✓。**关键经验:profile 里的路径必须用 realpath 解析后的路径**——`/tmp` 软链到 `/private/tmp`,literal 匹配不到。Apple 已标记废弃,按 R1 方案封装 `detectSandboxSupport()` + 降级
  - **bwrap(Linux)**:本机为 macOS,无法实测;实现为运行时探测,探测不到走降级路径
  - **自定义协议 + iframe sandbox**:留待 M5.6/M6.8 实现时验证,回退方案 `srcDoc` + 显式 CSP(R4)
  - 信息:`chore(deps): add cron-parser; probe OS sandbox + custom protocol`

## M1 导航骨架:菜单按钮 + 统一视图路由

> 现状:`AppLayout.tsx:140-185` 用 `canvasMode`/`knowledgeMode` 两个布尔 + 设置弹窗内 `view` 字符串控制一切;导航数组硬编码在 `AppLayout.tsx:314-327`。先抽骨架,后续中心只是往注册表加条目。

- [x] **M1.1 视图类型与注册表**
  - 范围:新增 `src/renderer/src/navigation/types.ts`(`AppView` 联合类型、`MenuItem` 类型)、`src/renderer/src/navigation/registry.ts`(六个菜单项 + 分隔分组 + 图标 + i18n key + 懒加载组件映射)
  - `AppView`:`chat | project | routines | capability | knowledge | tools`;`canvas` 保留为不可从菜单到达的隐藏视图
  - 交付:注册表是导航唯一事实源,新增视图只改一处
  - 验收:类型完备,无 `any`

- [x] **M1.2 导航状态集中**
  - 范围:新增 `src/renderer/src/stores/navigationStore.ts`(zustand,与 `stores/canvasStore.ts` 同模式):`view` / `params` / `menuOpen` / `navigate(view, params)` / `back()`
  - 交付:取代 `AppLayout.tsx:140-142,182-183` 的布尔与字符串
  - 验收:导航状态可被任意组件读写,不再靠 props 层层传递

- [x] **M1.3 左上角菜单按钮**
  - 范围:新增 `src/renderer/src/components/layout/AppMenu.tsx`(antd `Popover` + 分组列表);替换 `AppLayout.tsx:314-327` 的四个硬编码按钮
  - 分组:①新建对话/新建项目 ②日常工作/能力中心/知识中心/工具中心 ③设置/关于
  - 交付:菜单项全部走 M1.1 注册表
  - 验收:六个主入口 + 设置/关于均可点击到达(新视图先落占位页)

- [x] **M1.4 统一视图容器**
  - 范围:新增 `src/renderer/src/components/layout/ViewHost.tsx`;按注册表渲染,非聊天视图 `React.lazy`;沿用 `AppLayout.tsx:452-477` 的"聊天常驻 `display:none`"策略避免打断流式
  - 交付:AppLayout 只负责布局与聊天挂载
  - 验收:视图切换不重挂聊天,流式输出不中断

- [x] **M1.5 AppLayout 瘦身 + 头部动作区归位**
  - 范围:移除 `canvasMode`/`knowledgeMode`/`view`/`menuOpen` 状态;把知识模式专用的三个头部按钮(`AppLayout.tsx:371-398`)迁入知识视图自身的头部
  - 交付:AppLayout 目标 ≤450 行(现 646)
  - 验收:`AppLayout.tsx` 不再出现任何业务视图分支

- [x] **M1.5 完成注记**:AppLayout 646 → 525 行;头部不再有任何业务视图分支,知识导入工具条与进度条已迁入知识视图自身(ViewHost.KnowledgePane)。≤450 目标未达,余量是设置弹窗与全局样式块(M2 瘦身后继续降)
- [x] **M1.6 自由画布入口隐藏**
  - 范围:移除菜单/侧边栏的画布入口,`canvas` 视图保留但不注册到菜单;在 `CanvasView.tsx` 顶部加 `@deprecated 0.4.0 — 入口已隐藏,代码保留待评估` 说明 ✓(deprecated 标注已加,`npm test`/tsc 不受影响)
  - 验收:用户无法从 UI 到达自由画布;`npm test`/tsc 不因隐藏而失败
  - 信息:`refactor(nav): menu-driven view registry; hide legacy canvas entry`

## M2 能力中心(MCP / 技能 / 子代理 / 经验)

> 纯搬家 + 收拢,复用现有组件,不重写逻辑。

- [x] **M2.1 能力中心视图与页签**
  - 范围:新增 `src/renderer/src/components/capability/CapabilityCenter.tsx`(antd `Tabs`,懒挂载);四个页签分别内嵌 `settings/MCPSettings.tsx`、`settings/SkillSettings.tsx`+`SkillsPanel.tsx`、`settings/SubAgentSettings.tsx`、`settings/ExperiencePanel.tsx`
  - 交付:先梳理四个组件当前的 props 依赖(它们此前由设置弹窗传入),改为自取数据或由 ViewHost 注入
  - 验收:四个页签功能与现状逐项对齐(增删改查全部可用)

- [x] **M2.2 设置弹窗瘦身**
  - 范围:从 `AppLayout.tsx:494-525` 导航数组与 `renderView()`(`203-250`)移除 `tools`/`subagent`/`mcp`/`skills`/`experiences`
  - 保留:LLM 设置 / 助手 / 环境 / 记忆 / 收藏 / 统计 / 关于
  - 验收:设置弹窗无残留能力入口,无死代码分支

- [x] **M2.3 运行期跳转**
  - 范围:agent 经 `install` 工具装好 MCP/技能后的提示改为可点击跳转能力中心(经 `navigationStore`)
  - 验收:装完点提示能直接到对应页签

- [x] **M2.4 i18n 与验收**
  - 范围:`i18n/locales/zh.ts` / `en.ts` 新增能力中心相关 key,移除已迁走的设置项 key
  - 验收:双语无失效 key,`MCPSettings` 等组件无 i18n 回归
  - 信息:`feat(capability): relocate MCP/skill/subagent config into capability center`

## M3 项目 + 沙箱管控(最大风险)

> 现状:全局只有一个 `workspaceDir`(`src/shared/types/settings.ts:22`),**只是相对路径基准,无强制力**;文件 IPC 集中在 `src/main/ipc/file-ops.handler.ts`(通道 `UTIL_READ_FILE`/`UTIL_WRITE_FILE`);终端 `executeCommand(cmd, cwd)` 无路径限制;权限只有全局 `yoloMode` 与 MCP 级 `requireApproval`。
> 范围界定(D15):MCP/技能/子代理的启用状态**全局共享**,不随项目隔离;项目隔离的只有文件工作区与沙箱策略。

- [x] **M3.1 数据模型与迁移**
  - 范围:`src/main/storage/database.ts` 新增 `projects` 表 + `conversations.project_id` 列(需 `PRAGMA table_info` 守卫的 `ALTER TABLE`,现有 `createTables` 只有 `CREATE TABLE IF NOT EXISTS`)+ 索引;新增 `audit_log` 表(供 M3.12)
  - 迁移:`UPDATE conversations SET project_id='default' WHERE project_id IS NULL`
  - 交付:D1 的容器模型 + D5 的全局记忆/知识(不加 project 维度)
  - 验收:旧库升级后会话全部归入默认项目,无数据丢失;新库直接建全

- [x] **M3.2 ProjectStore + IPC + preload**
  - 范围:`src/main/storage/project-store.ts`(CRUD + 默认项目引导,`DEFAULT_PROJECT_ID='default'`,`workspaceDir` 取 `settings.workspaceDir ?? WORKSPACE_DIR`);`src/main/ipc/project.handler.ts`;`src/shared/ipc-channels.ts` 新增通道;`src/preload/index.ts` 桥接;`src/renderer/src/types/electron.d.ts` 类型
  - 通道:`project:list` / `project:get` / `project:create` / `project:update` / `project:delete`
  - 验收:项目 CRUD 全通;删除项目 = 连带删除项目内全部会话,弹窗列出会话数并二次确认(D17),不可静默丢数据

- [x] **M3.3 沙箱策略模型**
  - 范围:新增 `src/shared/sandbox/policy.ts`:`ProjectSandboxPolicy { fs: 'read-only'|'workspace-write'|'full-access'; network: 'allow'|'deny'; approval: 'auto'|'outside-ask'|'always-ask'; extraRoots?: string[]; hardIsolation: boolean }` + `DEFAULT_POLICY`(D2:workspace-write/allow/outside-ask/hardIsolation=false)+ 归一化与校验
  - 交付:策略是唯一裁决输入,`yoloMode` 降级为全局默认 `approval` 值
  - 验收:策略可序列化进 `projects.sandbox_json`,旧项目读取缺省即用默认值

- [x] **M3.4 路径守卫(必做)**
  - 范围:新增 `src/shared/sandbox/path-jail.ts` 纯函数:`isWithin(root, target)`、`guardPath({ workspaceDir, policy, target, operation })` 返回 `{ ok: true } | { ok: false; reason: string }`;常驻 `DENY_ROOTS`(`~/.ssh`、`~/.pulsemind`、系统目录、`~/Library/Keychains` 等);处理 `..`、绝对路径、`realpath` 软链解析、darwin/win 大小写
  - 单测:`tests/path-jail.test.ts`(附录 G)
  - 交付:纯函数零 IO 依赖,便于测试
  - 验收:全部逃逸用例被拒;工作区内正常路径零误杀

- [x] **M3.5 路径守卫接线(单一收口点)**
  - 范围:在 `src/main/ipc/file-ops.handler.ts` 统一包裹 `UTIL_READ_FILE`/`UTIL_WRITE_FILE` 及 list/search/find 类操作;策略来源 = 会话→项目映射(见 M3.6)
  - 交付:所有文件操作的主进程入口**只有一处**裁决,渲染层与主进程 host 都绕不过
  - 验收:越界返回结构化工具错误(非抛异常),agent 收到可读原因;`read-only` 下写操作被拒

- [x] **M3.6 会话→项目绑定与工作区解析**
  - 范围:`src/shared/agent-protocol/payloads.ts` 的 `session.create` 增加可选 `workspaceDir` / `projectId` / `sandbox`(可加字段,不改语义,无需 bump PROTOCOL_VERSION);`src/main/agent/session-manager.ts`(`:277` 现取全局 `settings.workspaceDir`)改为优先取会话自带的项目工作区,并登记 `sessionId → policy` 供 M3.5/M3.9 查询
  - 渲染侧:`src/renderer/src/hooks/useChatController.ts` / `App.tsx:226` 按项目传 `workspaceDir`;`src/renderer/src/types/conversation.ts` 增加 `projectId`
  - 验收:项目内会话的文件工具与终端都落在项目工作区;普通会话行为不变

- [x] **M3.7 项目视图 UI**
  - 范围:新增 `components/project/ProjectList.tsx`、`ProjectCreateDrawer.tsx`(目录选择走 `dialog.handler.ts` 现有能力、命名、初始沙箱策略、硬隔离开关)、`ProjectView.tsx`(项目头部展示工作区/沙箱/硬隔离 + 项目内会话列表 + 复用 `ChatView`)
  - 交付:项目内"新建对话"直接创建带 `projectId` 的会话;主侧边栏(`ConversationSidebar.tsx`)按项目分组折叠展示(D14)——项目名做分组头、可折叠,普通会话归「默认」组
  - 验收:新建项目→新建对话→发消息→文件落盘到项目工作区

- [x] **M3.8 沙箱策略面板**
  - 范围:项目头部「权限」入口 → `ProjectSandboxPanel.tsx`(三档 fs / 网络 / 审批 / 硬隔离 / extraRoots),改动即时生效并写审计
  - 验收:改策略后下次工具调用按新策略裁决

- [x] **M3.9 exec 硬隔离(可选启用)**
  - 范围:新增 `src/main/sandbox/exec-sandbox.ts`:`detectSandboxSupport()`、`wrapCommand(cmd, policy, workspaceDir)`——macOS 生成 `sandbox-exec -p` profile(只读根 + 工作区可写 + 网络按策略),Linux 生成 `bwrap` 参数;不可用时返回 `null` 并由调用方降级为审批 + 审计;接入 `src/main/services/terminal.ts`
  - 交付:UI 明确标注"硬隔离 / 软沙箱(仅审批)",不制造安全错觉
  - 验收:`hardIsolation=on` 且平台支持时,命令无法写工作区外;平台不支持时给出显式提示且行为降级可预期

- [x] **M3.10 审批路由**(实现注记:exec 走引擎现有审批链——项目策略 approval=auto 映射为引擎 yolo,其余两档走非 yolo 询问;fs 写入的"越界询问"以 path-jail 拒绝+审计落地,不做弹窗放行——v1 语义:越界即拒)
  - 范围:策略 → 裁决:工作区内自动放行 / 越界按 `outside-ask` 弹审批 / `always-ask` 全弹;复用现有审批 UI(`components/terminal/CommandCard.tsx`)与 `engine/execution-flow.ts` 的 approve/reject 流程
  - 验收:`auto` 不弹窗、`outside-ask` 仅在越界弹、`always-ask` 每次弹;拒绝后 agent 收到拒绝结果并可继续

- [x] **M3.11 MCP / 子代理 / 生成工具继承策略**
  - 范围:MCP stdio 子进程 cwd=项目工作区 + env 清洗(`src/main/mcp/transport.ts`);`spawn_agent` 子代理与画布引擎继承父会话策略(`agent/engine/spawn-manager.ts`、`components/canvas/canvasEngine.ts`)
  - 验收:子代理无法绕过父会话沙箱

- [x] **M3.12 审计**
  - 范围:新增 `src/main/storage/audit-store.ts`(写 `audit_log` 表):记录时间、会话/项目、工具、目标路径或命令摘要、策略、裁决结果;IPC `audit:list`;项目沙箱面板内可查看
  - 验收:每次越界/审批/拒绝可回溯;审计写入失败不影响主流程
  - 信息:`feat(project): workspace-scoped projects with enforced sandbox policy`

## M4 日常工作 + 定时计划

> 现状:**无任何调度能力**;技能(`SkillDefinition`)是纯提示注入,不可独立执行。D3 决定二者概念分离。

- [x] **M4.1 Routine 模型与存储**
  - 范围:新增 `src/shared/types/routine.ts`(`Routine`、`RoutineRun`);定义落 `~/.pulsemind/routines/<id>.json`;运行历史落 SQLite 新表 `routine_runs`(id/routine_id/conversation_id/status/trigger/started_at/finished_at/error)
  - 交付:`params` 为轻量参数声明(`{key,label,required,default}`),不支持复杂类型(v1)
  - 验收:读写往返一致,损坏 JSON 不影响启动

- [x] **M4.2 RoutineStore + IPC + preload**
  - 范围:`src/main/storage/routine-store.ts`;`src/main/ipc/routine.handler.ts`;通道 `routine:list|get|create|update|delete|toggle|run|runs`;preload 与 `electron.d.ts`
  - 验收:CRUD + 运行 + 历史查询全通

- [x] **M4.3 日常工作视图**
  - 范围:新增 `components/routine/RoutineList.tsx`(启停开关、下次运行时间、最近一次状态、手动「立即运行」)、`RoutineEditor.tsx`(Drawer:名称/描述/提示词/参数/计划(Cron 文本框 + 常用预设)/启用/绑定项目)、`RoutineRunHistory.tsx`(状态、耗时、跳转产物会话)
  - 交付:cron 表达式经 `cron-parser` 做合法性校验,非法即时报错并给出首个下次运行时间
  - 验收:手动运行产出会话并出现在历史中

- [x] **M4.4 从对话提取**(实现注记:v1 入口在日常工作页「从对话提取」选会话;消息级悬浮入口留待 M7 打磨)
  - 范围:新增 `src/renderer/src/agent/one-shot-agent/RoutineExtractionAgent.ts`(复用现有 one-shot 模式),入口为消息右键/悬浮的「存为日常工作」;结果先落草稿进审阅 Drawer,确认后入库
  - 交付:提取内容为 名称 + 描述 + 提示词 + 建议计划,用户可改
  - 验收:一段普通对话能提取出可运行的 routine,且不覆盖已有同名项

- [x] **M4.5 RoutineRunner(主进程)**
  - 范围:新增 `src/main/routine/routine-runner.ts`:经 `agentSessionManager.createSession({ title, agentId, workspaceDir, projectId })` 建 `type='routine'` 会话 → `ask(渲染后的提示词)` → 完成后写 `routine_runs` → 通知;参数以模板变量替换注入提示词
  - 交付:运行即产出真实会话,可追溯、token 计入 `token_usage`;无人值守审批(D13)——定时触发时工作区内自动放行,越界/需审批一律自动拒绝,记入 `routine_runs.error` 并在产物会话标记被跳过的步骤,支持人工补跑
  - 验收:手动与定时触发走同一条运行路径;定时运行遇审批操作不挂起、不丢记录

- [x] **M4.6 RoutineScheduler(主进程)**
  - 范围:新增 `src/main/routine/routine-scheduler.ts`:`cron-parser` 计算下次运行、30s tick、`next_run_at` 持久化(重启续期)、错过补跑策略(可配:补跑一次 / 跳过)、上次未完成则重叠跳过、全局并发上限(复用 M2.2 的 FIFO 排队);随 `app.whenReady` 启动,托盘常驻下持续运行
  - 交付:调度器与运行器解耦,便于单测调度决策
  - 验收:窗口关闭(托盘常驻)仍按时触发;错过的计划按策略补跑;不会并发堆叠同一 routine

- [x] **M4.7 通知**
  - 范围:完成/失败经托盘(`src/main/tray.ts`)+ 系统 `Notification`;点击打开对应产物会话
  - 验收:通知可点击跳转;失败通知带错误摘要

- [x] **M4.8 技能注入边界**
  - 范围:routine 可选绑定技能,运行时经 `SkillManager.getSystemPromptAppendix()` 注入;**不读写技能的 `enabledSkills` 全局状态**(D3)
  - 验收:绑定技能只影响该 routine 的运行,不改动能力中心的技能启用状态
  - 信息:`feat(routine): schedulable daily-work routines with cron and run history`

## M5 工具中心 I:创作与画廊

> D6/D9/D11/D12 决定:**不建脚本沙箱、不注册 agent 工具**。核心是"多轮对话 → 生成 HTML 工具 → 迭代修改 → 统一画廊"。生成内核复用现有 `components/canvas/canvasEngine.ts`(其已具备:在 workDir 生成 `index.html`、读回校验、工具事件流)。

- [x] **M5.1 UserTool 模型与存储**
  - 范围:新增 `src/shared/types/user-tool.ts`(`UserTool`);落盘 `~/.pulsemind/tools/<id>/`:`tool.json`(清单)+ `app.html`(产物)+ `storage.json`(KV)+ `assets/`;新增 `src/main/storage/tool-store.ts`
  - 清单字段:`id/name/description/icon/category/htmlPath/conversationId/capabilities[]/sourceTemplateId?/version/createdAt/updatedAt`
  - 验收:工具目录可独立拷贝、可删除、可导出

- [x] **M5.2 生成内核抽取**
  - 范围:从 `canvasEngine.ts` 抽出 `src/renderer/src/tool-studio/generator.ts`(`HtmlAppGenerator`:需求 → 生成 `app.html` → 迭代修改 → 读回校验),`canvasEngine` 改为委托同一内核(保证隐藏的画布仍可用)
  - 交付:生成提示词模板独立成文件(澄清轮次模板 + 生成模板 + 迭代修改模板)
  - 验收:内核不含画布概念(annotation/rect),类 ≤1000 行、方法 ≤200 行

- [x] **M5.3 工具 API 与 IPC**
  - 范围:新增 `src/main/ipc/tool.handler.ts`;通道 `tool:list|get|create|update|delete|clone|export|read-html`;preload 与 `electron.d.ts`
  - 验收:画廊数据、工具文件读取、导出下载全通

- [x] **M5.4 工具画廊**
  - 范围:新增 `components/tool-studio/ToolGallery.tsx`:分页签「我的工具 / 预置模板」,卡片含缩略图(首次打开时截首屏并缓存)、名称、描述、能力徽标、操作(打开/编辑/复制/导出/删除);右上角显眼「+ 创造工具」
  - 交付:空状态引导(直接给"从模板复制"与"创造"两条路径)
  - 验收:至少能打开、复制模板、导出、删除;缩略图失败时降级为占位图

- [x] **M5.5 工具工作室(创作流程)**
  - 范围:新增 `components/tool-studio/ToolStudio.tsx`:左侧需求澄清对话(复用 ChatView 的消息渲染,或轻量对话组件)+ 右侧实时预览;流程 = 多轮澄清 → 「需求确认,开始生成」→ 生成中 → 完成后左侧切换为"继续提修改要求"的迭代对话
  - 交付:澄清阶段的对话与生成产物共用同一个会话(`conversationId` 入清单),便于回溯
  - 验收:能从零用几轮对话生成一个可用工具;生成后继续提要求能正确修改而非重做

- [x] **M5.6 工具运行视图**(实现注记:v1 用 srcDoc + sandbox="allow-scripts" 严格沙箱——不透明源,无 localStorage,生成器提示词已要求工具做存储降级;pulsemind-tool:// 自定义协议留待 M6.8 一并验证,不可行则维持 srcDoc)(实现注记:v1 用  +  严格沙箱(不透明源,无 localStorage——生成器提示词已要求工具做存储降级); 自定义协议留待 M6.8 一并验证,失败即维持 srcDoc)
  - 范围:新增 `components/tool-studio/ToolRunner.tsx`:自定义协议加载 `app.html`(复用 `src/main/index.ts:404` 的 `protocol.handle` 模式,新增 `pulsemind-tool://`),严格 iframe sandbox 渲染 + 全屏运行 + 迭代面板
  - 交付:M6 未落地前先跑纯前端能力(无 bridge 时优雅提示)
  - 验收:工具可独立打开运行并交互

- [x] **M5.7 预置模板**
  - 范围:新增 `templates/pulsemind/tools/`(随首次运行拷贝到 `~/.pulsemind/tools/templates/`,沿用现有 `templates/pulsemind/` 拷贝机制);首批 6 个:计算器、番茄钟、取色器、Post 工具(HTTP client)、Markdown 便签、JSON 格式化
  - 交付:每个模板 = `app.html` + `tool.json`(含 `capabilities` 声明),"复制改造" = 克隆为我的工具
  - 验收:模板可复制、可运行、可编辑;模板目录缺失时优雅跳过

- [x] **M5.8 导出**
  - 范围:导出 `app.html`(单文件下载)/ 在系统浏览器打开
  - 验收:导出文件双击可在浏览器直接运行(纯前端能力部分)
  - 信息:`feat(toolstudio): creative tool studio — gallery, dialog-driven generation, iteration`

## M6 工具中心 II:运行时能力层

> D10 决定工具可用**网络 + 本地文件 + 系统能力**。iframe 严格 sandbox 下没有 `localStorage`(不透明源),因此持久化统一走 bridge;所有能力经**能力声明 + 首次授权 + 项目策略 + 审计**四道约束。

- [x] **M6.1 Bridge 协议**
  - 范围:新增 `src/shared/tool-bridge/protocol.ts`:`postMessage` 信封(`{ id, method, params }` / `{ id, ok, result | error }`)、方法名常量、错误码、超时约定
  - 交付:协议在 shared,宿主与 SDK 共用一份类型
  - 验收:类型自洽,非法方法的错误码明确

- [x] **M6.2 SDK 注入**
  - 范围:新增 `src/renderer/src/tool-studio/sdk/pulsemind.js`(加载工具页面时注入),定义 `window.pulsemind.*`(附录 D);每次加载生成一次性 nonce
  - 交付:所有方法返回 Promise,统一 `{ok, error}` 语义
  - 验收:页面内 `await pulsemind.storage.set(...)` 可用

- [x] **M6.3 宿主侧桥接**
  - 范围:新增 `src/renderer/src/tool-studio/bridge-host.ts`:校验消息来源(`event.source === iframe.contentWindow` + nonce + toolId)→ 能力判定 → 转 IPC
  - 交付:不信任页面传入的任何 toolId,以宿主上下文为准
  - 验收:伪造 nonce / 跨窗口消息被丢弃

- [x] **M6.4 主进程能力实现**
  - 范围:新增 `src/main/tool-runtime/http-proxy.ts`(出站 HTTP:绕 CORS、超时、响应大小上限、host 黑白名单;可复用 `src/main/mcp/chrome-fetcher.ts`)、`fs-ops.ts`(受 `path-jail` 约束,默认仅允许工具自身目录;更广路径须经 `pickFile`/`pickDirectory` 用户当场选择,选择即授权——D16)、`system-ops.ts`(剪贴板、通知、`shell.openExternal/openPath`)
  - 通道:`toolbridge:http|fs|storage|system`(单一入口 `toolbridge:invoke` 也可,按实现便利选一)
  - 验收:Post 工具能发出跨域请求并拿到响应;越界文件写入被拒

- [x] **M6.5 能力声明与授权**(实现注记:v1 能力仅来自模板声明;工作室新生成的工具默认零能力——安全默认,授权 UI 留待打磨。项目策略收紧网络的一点在工具运行于项目会话内时生效,v1 工具全局运行,host 黑名单兜底)
  - 范围:`tool.json` 的 `capabilities[]`(如 `net:http`、`fs:read`、`fs:write`、`clipboard`、`notify`、`open-external`);创建/生成完成时展示需授权清单,用户一次性确认;未声明的能力调用直接拒绝
  - 交付:项目沙箱策略可进一步收紧(如 `network: deny` 时即使工具声明了也拒绝),策略优先于声明
  - 验收:未声明调用被拒且提示可读;策略收紧后已授权工具的网络调用立即失效

- [x] **M6.6 持久化 KV**
  - 范围:`pulsemind.storage.get/set/remove/keys` → `~/.pulsemind/tools/<id>/storage.json`(带写入节流与大小上限)
  - 交付:不用 `localStorage`(严格 sandbox 下不可用),统一走 bridge
  - 验收:重开工具后数据仍在;超限写入返回可读错误

- [x] **M6.7 审计**
  - 范围:所有 bridge 调用写审计流(工具 id、方法、参数摘要、结果状态、耗时、是否越权);未授权/被拒调用单独标记
  - 验收:工具产生的网络与文件行为可完整回溯

- [x] **M6.8 安全基线**
  - 范围:iframe `sandbox="allow-scripts"`(不加 `allow-same-origin`)、CSP、`referrerpolicy="no-referrer"`;工具页面经 `pulsemind-tool://` 协议加载而非 `srcDoc`;M0.2 已验证的组合才落地
  - 交付:能力边界与降级路径写进 `CLAUDE.md`
  - 验收:工具页面无法直接访问宿主 DOM / `window.electronAPI` / 不经 bridge 的文件系统
  - 信息:`feat(toolruntime): capability-scoped bridge for network, files and system APIs`

## M7 回归与收尾

- [ ] **M7.1 i18n 全量补齐**
  - 范围:zh/en 覆盖新导航、四个中心、沙箱/授权/审计文案;清理已迁移项的失效 key
  - 验收:双语无缺失、无残留
- [ ] **M7.2 数据迁移与兼容**
  - 范围:旧会话归默认项目;旧设置项读取兼容;自由画布数据(`localStorage` + `~/.pulsemind/canvas/`)保持不动但入口隐藏
  - 验收:从 0.3.5 升级后无功能回归、无数据丢失
- [ ] **M7.3 文档**
  - 范围:`CLAUDE.md` / `AGENTS.md` 更新:新信息架构、新运行时目录(`tools/`、`routines/`)、`projects`/`routine_runs`/`audit_log` 表、沙箱策略与 bridge 能力边界
  - 验收:新目录与新概念在文档中可查
- [ ] **M7.4 测试与基线**
  - 范围:按附录 G 补齐纯逻辑单测;tsc 两侧只降不升;构建冒烟
  - 验收:附录 G 全绿
- [ ] **M7.5 打包验证**
  - 范围:打包后验证 `sandbox-exec`/`bwrap` 可用性、`pulsemind-tool://` 协议与 iframe 组合、模板拷贝、托盘常驻下定时触发
  - 验收:打包产物完成一次端到端走查(项目→沙箱→日常定时→创造工具→运行)
  - 信息:`docs(plan): 0.4.0 regression + docs refresh`

---

## 附录 A:迁移对象对照表

| 现状位置 | 现入口 | 目标位置 |
|---|---|---|
| `settings/MCPSettings.tsx` | 设置弹窗 `mcp` | 能力中心 · MCP |
| `settings/SkillSettings.tsx` + `SkillsPanel.tsx` | 设置弹窗 `skills` | 能力中心 · 技能 |
| `settings/SubAgentSettings.tsx` | 设置弹窗 `subagent` | 能力中心 · 子代理 |
| `settings/ExperiencePanel.tsx` | 设置弹窗 `experiences` | 能力中心 · 经验 |
| `settings/ToolSettings.tsx` + `ToolsPanel.tsx` | 设置弹窗 `tools` | **留在设置弹窗**(D9:画廊里的"内置工具"指预置模板,非 Agent 工具) |
| `components/canvas/*` | 侧边栏「自由画布」 | 入口隐藏,代码保留(D7);生成内核被 M5.2 复用 |
| `components/knowledge/KnowledgePanel.tsx` | 侧边栏「知识管理」 | 知识中心(不变) |
| `settings/LlmSettings`/`AgentSettings`/`EnvironmentSettings`/`MemorySettings`/`FavoritesSettings` | 设置弹窗 | 设置弹窗(保留) |

## 附录 B:新增数据模型

```sql
-- projects(M3.1)
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  icon          TEXT,
  sandbox_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- conversations 增列(需 PRAGMA 守卫)
ALTER TABLE conversations ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, updated_at DESC);

-- routine_runs(M4.1)
CREATE TABLE IF NOT EXISTS routine_runs (
  id              TEXT PRIMARY KEY,
  routine_id      TEXT NOT NULL,
  conversation_id TEXT,
  status          TEXT NOT NULL,   -- running|success|failed|skipped
  trigger         TEXT NOT NULL,   -- manual|schedule
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT
);

-- audit_log(M3.12 / M6.7)
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  scope       TEXT NOT NULL,   -- project|tool|routine
  actor       TEXT,            -- conversationId | toolId | 'scheduler'
  action      TEXT NOT NULL,   -- fs.read|fs.write|exec|http|clipboard|...
  target      TEXT,            -- 路径 / 命令摘要 / URL host
  decision    TEXT NOT NULL,   -- allowed|denied|approved|rejected|auto
  policy_json TEXT,
  meta_json   TEXT
);
```

```ts
// 工作区文件格式
~/.pulsemind/routines/<id>.json        // Routine
~/.pulsemind/tools/<id>/tool.json      // UserTool 清单
~/.pulsemind/tools/<id>/app.html       // 生成的工具页面
~/.pulsemind/tools/<id>/storage.json   // bridge KV
~/.pulsemind/tools/templates/          // 预置模板(首次运行从 templates/pulsemind/tools 拷贝)
```

```ts
interface Project {
  id: string; name: string; workspaceDir: string; icon?: string
  sandbox: ProjectSandboxPolicy; createdAt: string; updatedAt: string
}
interface Routine {
  id: string; name: string; description: string; prompt: string
  params?: Array<{ key: string; label: string; required?: boolean; default?: string }>
  schedule?: { cron: string; timezone?: string; catchUp?: 'once' | 'skip' }
  enabled: boolean; projectId?: string; sourceConversationId?: string; createdAt: string
}
interface UserTool {
  id: string; name: string; description: string; icon?: string; category?: string
  htmlPath: string; conversationId?: string
  capabilities: Array<'net:http' | 'fs:read' | 'fs:write' | 'clipboard' | 'notify' | 'open-external'>
  sourceTemplateId?: string; version: number; createdAt: string; updatedAt: string
}
```

## 附录 C:沙箱与能力裁决矩阵

| 面 | 现状 | 目标 | 裁决点 |
|---|---|---|---|
| 文件工具 | 无约束 | 路径守卫 + 黑名单,越界即拒 | `file-ops.handler.ts`(唯一收口) |
| 终端 `exec` | 任意命令任意 cwd | cwd 锁工作区 → 硬隔离(可用时)→ 审批分级 | `services/terminal.ts` + `sandbox/exec-sandbox.ts` |
| MCP 子进程 | 无 cwd/env 约束 | cwd=工作区、env 清洗、继承项目策略 | `mcp/transport.ts` |
| 子代理 / 画布引擎 | 继承全局设置 | 继承父会话项目策略 | `spawn-manager.ts`、`canvasEngine.ts` |
| Web 工具 bridge | 不存在 | 能力声明 + 授权 + 项目策略 + 审计 | `tool-runtime/*` + `bridge-host.ts` |
| 审批 | 全局 `yoloMode` + MCP 级开关 | 项目级三档,`yoloMode` 为全局默认 | `execution-flow.ts` |

策略优先级:**项目策略 > 工具能力声明 > 默认值**。

## 附录 D:工具 Bridge API(SDK 面)

```js
window.pulsemind = {
  // 出站 HTTP(绕 CORS;受 network 策略约束;host 黑白名单;审计)
  http: { request({ url, method, headers, body, timeoutMs }) -> { status, headers, body } },

  // 本地文件(受 path-jail 约束;默认仅工具目录 + 项目工作区;可弹审批)
  fs: { readText(path), writeText(path, text), list(path), exists(path),
        pickFile({ filters }), pickDirectory() },

  // 键值持久化(不用 localStorage,严格 sandbox 下不可用)
  storage: { get(key), set(key, value), remove(key), keys() },

  // 系统能力(每项独立授权)
  system: { clipboard: { readText(), writeText(t) },
            notify({ title, body }),
            openExternal(url), openPath(path) },

  ui: { setTitle(t), toast(msg, level) },

  meta: { toolId, version, capabilities }   // 只读,由宿主注入,不接受页面伪造
}
```

## 附录 E:预置模板清单(M5.7)

| 模板 | 所需能力 | 说明 |
|---|---|---|
| 计算器 | 无 | 验证纯前端链路 |
| 番茄钟 | `notify` | 计时 + 系统通知 |
| 取色器 | `clipboard` | 取色并写剪贴板 |
| Post 工具(HTTP client) | `net:http`、`storage` | 验证跨域代理与请求历史 |
| Markdown 便签 | `fs:read`、`fs:write` | 验证文件读写与授权 |
| JSON 格式化 | `clipboard` | 纯前端 + 剪贴板 |

## 附录 F:新增 IPC 通道清单

```
project:list / project:get / project:create / project:update / project:delete
routine:list / routine:get / routine:create / routine:update / routine:delete
routine:toggle / routine:run / routine:runs
tool:list / tool:get / tool:create / tool:update / tool:delete / tool:clone / tool:export / tool:read-html
toolbridge:http / toolbridge:fs / toolbridge:storage / toolbridge:system
audit:list
sandbox:detect
```

## 附录 G:测试清单(纯逻辑,进 vitest)

1. `path-jail`:`../` 逃逸、绝对路径、软链穿透、darwin/win 大小写、`DENY_ROOTS` 命中、`read-only` 拒写、`extraRoots` 放行
2. `sandbox/policy`:归一化、缺省填充、非法值回退
3. `cron`:包装函数的合法性校验与 `nextRun`(跨月末/跨年/时区)
4. `routine-scheduler`:到点触发、重叠跳过、过点补跑/跳过、`enabled=false` 不触发
5. `project-store`:默认项目引导、旧库迁移幂等、删除项目的会话处置
6. `user-tool`:清单校验、能力授权判定、策略收紧时的拒绝
7. `tool-bridge protocol`:消息信封编解码、非法方法错误码、nonce 校验

## 附录 H:风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | `sandbox-exec` 已被 Apple 标记废弃,未来可能移除 | 硬隔离失效 | M0.2 实测;封装 `detectSandboxSupport()`;不可用降级为审批 + 审计并显式提示 |
| R2 | Windows 无等价轻量沙箱 | 该平台只有软沙箱 | v1 明确不做,UI 标注;策略仍提供路径守卫与审批 |
| R3 | 严格 iframe sandbox 下无 `localStorage` | 工具持久化失败 | 统一走 bridge KV(附录 D),不暴露 localStorage |
| R4 | 自定义协议 + iframe 严格 sandbox 组合兼容性 | 工具加载失败 | M0.2 先验证可行组合,不可行则回退 `srcDoc` + 显式 CSP |
| R5 | 生成 HTML 质量不稳定 | 工具不可用 | 澄清轮次模板 + 实时预览 + 迭代修改 + 预置模板兜底 |
| R6 | 定时依赖托盘常驻;win/linux `residentMode` 未落 | 该平台关窗后不触发 | 与 `PLAN-0.3.5` M2.3 联动;未落地前 UI 明示"需保持应用运行" |
| R7 | Web 工具能力面大(网络+文件+系统) | 安全风险最高 | 四道约束:能力声明 / 首次授权 / 项目策略优先 / 全量审计 |
| R8 | `canvasEngine` 抽取影响隐藏中的画布 | 画布回归 | 画布改为委托同一内核,抽取后跑一次画布冒烟 |
| R9 | `CanvasView.tsx` 1448 行、`AppLayout.tsx` 646 行 | 超规范 | 触及即拆;M1.5 要求 AppLayout ≤450 |
| R10 | `cron-parser` 新增依赖 | 供应链面 | 体积小、久经考验;锁定版本 |

## 非目标(本期不做)

- 不做生成的工具被 agent 调用(D11)
- 不做多项目并行工作台 / 多窗口
- 不做工具市场、云端同步、团队共享
- 不做脚本型自定义工具(Node/Python/Shell 沙箱)——已被"创意设计中心"取代
- 不做复杂的画布节点编排(DAG / 连线)
- 不做项目级记忆与知识隔离(D5)
- 不做 Windows 硬沙箱(R2)

## 执行约定

1. 每任务一分支提交(沿用 `feat/fix/refactor/docs(scope):` 规范),按任务勾选本文档随提交更新
2. 破坏性变更(表结构、存储格式、协议字段)必须带迁移路径,保证旧版本数据可升级;`session.create` 只加可选字段,不 bump `PROTOCOL_VERSION`
3. 每个任务结束保持"中间态可发布":应用可正常聊天
4. 新代码遵守 AGENTS.md:类 ≤1000 行、方法 ≤200 行、先检索 `src/shared/`、`src/renderer/src/utils/`、`src/main/utils/` 再动手
5. 安全相关任务(M3.4–M3.12、M6.4–M6.8)完成后,验收必须包含一次**人工越权尝试**(而非只有单测通过)
6. 视觉规格无设计稿(D18):新视图按现有页面的 antd 风格、密度与配色自拟;M1 完成后先交「菜单 + 一个视图」小样定调,再铺开其余视图
