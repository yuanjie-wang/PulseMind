# PLAN: PulseMind 浏览器插件 —— 浏览器内的轻量 Agent

> 目标:用户在任意网页上打开 PulseMind 面板,agent 能"看见"当前页面并"操作"当前页面,复用桌面端已有的 agent 能力(引擎/记忆/技能/MCP/审批)。
> 参考基线:本地 `../Anywhere`(扩展 + 本地 Agent 服务的已验证双端实现)。
> 本文**接管 PLAN-0.3.5 的 M3(托管工具+审批链)/ M4(扩展接入)**两条未勾选线,并细化到可执行粒度;0.3.5 中对应条目改为指向本文。
> 状态:设计基线已定稿(2026-09-14,七项决策见 §9);可开工 M0。

---

## 0. 结论(TL;DR)

1. **插件不是第二个 agent,而是 PulseMind 本地服务的协议客户端。** 桌面端主进程已经托管了 AgentEngine(`src/main/agent/session-manager.ts`),并已用 loopback WebSocket 暴露了协议(`src/main/agent/ws-server.ts`)。插件只做三件事:渲染对话、采集页面上下文、执行页面工具。
2. **"轻量"落在两处**:①插件侧零 agent 逻辑(无 LLM 调用、无 API Key、无记忆/技能库);②扩展会话走 `allowedTools` 白名单(只有 `page_*` 八件),不见 `exec`/`write`/`fs`/`browser`(Playwright)等重型工具。
3. **与 Anywhere 的最大差异:PulseMind 已经建好了服务端的 70%。** Anywhere 需要自建 Node 服务 + AgentLoop + 工具 + 记忆 + 技能;PulseMind 这些早已存在,本 Plan 主要是**补协议缺口 + 写插件**。
4. 服务端缺口集中在 `ws-server.ts`:目前只实现了 6 个方法,`tool.call`/`tool.result`(反向 RPC)、`approval.*`、`ask_user.*`、`pageContext` 全部只有类型定义没有分发(PLAN-0.3.5 M3.1–M3.3)。
5. 首发形态(裁定 1):**页面内浮层**(FAB + Shadow Root 隔离,React 跑在 content script 隔离世界),常驻 `<all_urls>` 注入(裁定 5);侧边栏降为 M4 可选第二入口。因此样式隔离与"导航后重挂"从 M1 就要做,不是尾期打磨项(站点 CSP 只影响 `page_execute_js`,不影响面板本身 —— 见 §3.6)。
6. 分期:**M0 协议补齐 → M1 浮层 + 跑通流式对话 → M2 页面工具(看/点/填) → M3 审批与隐私 → M4 第二入口与体验 → M5 品牌与分发**。M1 结束即可日常使用,M2 才是"值钱"的那一步。

---

## 1. 现状盘点

### 1.1 PulseMind 侧已就位(直接复用,不改)

| 资产 | 位置 | 对插件的意义 |
|---|---|---|
| AgentEngine + engine/* 策略模块 | `src/renderer/src/agent/AgentEngine.ts`(922 行)+ `agent/engine/` | 推理循环、压缩管线、stopReason 分发、孤儿修复;插件一行都不用碰 |
| 主进程会话管理器 | `src/main/agent/session-manager.ts` | 多会话、并发上限(FIFO)、会话事件流、`engineCall` 白名单 |
| 主进程 Host | `src/main/agent/main-host.ts`(`mainHost`) | 引擎的一切外部依赖(Node 直连),含持久化/记忆/MCP/终端 |
| loopback WS 服务 | `src/main/agent/ws-server.ts` | token 鉴权、JSON-RPC 分发、心跳、同 clientId 踢旧、事件扇出 |
| 协议包(单一事实源) | `src/shared/agent-protocol/`(`jsonrpc`/`methods`/`payloads`) | 方法名与 Anywhere 刻意同名同义,一份客户端可打两家 |
| 服务生命周期 | `src/main/service-runtime.ts` + `src/main/service-config.ts` | 开关/端口/重启;token 落 `~/.pulsemind/service-token` |
| 桌面服务设置页 | PLAN-0.3.5 M2.4(已勾选) | 已有 开关/端口/token 查看重置/状态,本 Plan 只加一张「浏览器插件」卡 |
| 会话来源标记 | `conversations.origin`(`database.ts:237` ALTER) + `updateConversationOrigin` | 浏览器会话可直接落库并标记来源 |
| 审批分级 | `src/shared/sandbox/policy.ts` `requiresApproval(mode, tier)`;会话级 `conversations.approval_mode` | 页面写操作复用同一把梯子,不新造 |
| ask_user 工具 | `built-in-tools.ts:213-241` + `execution-flow.ts:84` + `respondToTool` | 插件的问答卡直接对接,无需新工具 |
| 工具门控机制 | `agent/engine/tool-collection.ts:42-63`(gated + 关键字激活) | 页面工具的"在线才可见"挂在这里 |

### 1.2 PulseMind 侧缺口(本 Plan 要补)

| 缺口 | 现状 | 补法 |
|---|---|---|
| **G1 反向 RPC** | `Methods.toolCall/toolResult` 只有类型;`ws-server.ts` 的 switch 落到 `methodNotFound`(`ws-server.ts:171`) | 新增 `src/main/agent/hosted/` 模块:hosted 工具注册表 + callId 关联的 pending map + 超时 + 孤儿丢弃 |
| **G2 审批路由** | 引擎只会把 `agentStatus` 置为 `awaiting_approval`(`types/agent.ts:11`),由桌面 UI 调 `approveTool`;远端客户端拿不到审批请求 | 状态驱动路由:`awaiting_approval` → `approval.request`(callId = toolUseId)→ 扩展回 `approval.response` → `engineCall('approveTool'/'rejectTool')` |
| **G3 pageContext** | `PageContext` 类型已定义(`payloads.ts:66-71`),`agent.ask` 不接收 | `agent.ask` 透传到 `session-manager.ask`,写进 system prompt 的 Current Page 段(并供未来的站点路由用) |
| **G4 会话恢复** | `agent.history` 走 `ensureEntry`,桌面端重启后内存无此会话 → `sessionNotFound` | `session.create` 支持传既有 `sessionId`:命中 `getConversation` 则 `createSession` + `hydrate`(session-manager 已有 `hydrate`,`:508`) |
| **G5 hosted 在线门控** | 无"在线客户端声明的工具集"概念 | `collectEnabledTools` 增加 hosted 集过滤:会话绑定客户端未连 → `page_*` 不出现在工具表 |
| **G6 端口发现** | 默认 8765,冲突时回退 `listen(0)`(`ws-server.ts:209-213`、`service-runtime.ts:36`)→ 随机端口,插件无法发现 | 改为**确定性扫描**(8765→8779),两端约定同一区间 |
| **G7 配对引导** | 只有 `GET /` 存活响应 | 新增 `GET /token`(要求 `Origin: chrome-extension://*` + Host 回环),插件自动配对;失败可手输 |
| **G8 upgrade 校验** | 只校验 token,不看 Origin | 补 Origin 白名单(浏览器来源必须是 `chrome-extension://`),防网页侧 DNS rebinding 打本地服务 |

### 1.3 Anywhere 侧可移植资产(`../Anywhere/packages/extension`)

| 资产 | 行数 | 处置 |
|---|---|---|
| `src/content/dom-tree.ts` | 598 | **直接移植**(改名 `page-tree.ts`)。DOM 重分析 + 属性白名单 + WeakMap 定位 + 4000 节点上限,是本方案的核心资产 |
| `src/content/dom-tools.ts` | 145 | 移植,工具名改 `page_*`;补 `page_back`/`page_wait` |
| `src/common/js-exec.ts` | 51 | 移植(AsyncFunction + 结果序列化) |
| `src/background/ws-client.ts` | 231 | 移植骨架:握手/退避重连/pending map/超时;去掉 anywhere 专有字段 |
| `src/background/state.ts` | 103 | 移植:`chrome.storage.session` 持久化 tabId↔sessionId、panel 状态 |
| `src/background/tool-router.ts` | 109 | 移植:session→tab 路由 + `tool.result` 回写 |
| `src/background/cdp.ts` | 49 | 移植:CSP 阻断 eval 时 `chrome.debugger` 回退 |
| `manifest.json` | — | 骨架复用,但**权限收窄**(见 §3.6) |
| `src/shared/useChat.ts` 事件归约思路 | 282 | 参考;PulseMind 事件面不同(镜像型),按 §3.1.4 重写 |
| `src/content/popup-relay.ts` / popup 窗口模式 | — | **不移植**(Anywhere 侧已是未接线的死代码) |

### 1.4 为什么不把 agent 循环放进插件(决策 D1)

扩展直连 LLM(自带 Key)看似省掉桌面端常驻,但要重新实现压缩管线/记忆/技能/MCP/审批,并让 API Key 进浏览器存储;两套实现必然漂移。Anywhere 的经验也指向同一结论:**服务为中心,客户端只做 transport**。桌面端未运行时,插件降级为"未连接"提示 + 启动指引(见 §3.2.3),不做第二套 agent。

---

## 2. 总体架构

```
┌─────────────────────────── 浏览器 (MV3 扩展) ───────────────────────────┐
│  side panel / 页面内浮层 (React)  ← 对话 UI、审批卡、问答卡              │
│        ▲ agent.event                    │ agent.ask / approval.response  │
│  background service worker: 连接管理 + tabId↔sessionId + 角色路由        │
│        ▲ TOOL_CALL                              │ tool.result            │
│  content script (常驻注入 <all_urls>): FAB/浮层宿主 + DOM 管线 + page_* 执行 │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ WebSocket JSON-RPC 2.0 (127.0.0.1, ?token=)
                                 ▼
┌──────────────────── PulseMind 桌面端主进程(唯一 agent 宿主) ────────────┐
│  agent/ws-server.ts        连接/鉴权/分发/事件扇出                       │
│  agent/hosted/            【新】hosted 工具注册 + 反向 RPC + 审批路由    │
│  agent/session-manager.ts  会话(AgentEngine 实例)、并发、engineCall      │
│  renderer/src/agent/*      AgentEngine + 压缩/工具/记忆/技能(原样复用)   │
│  storage/*                 SQLite 会话、记忆、技能、MCP、审计           │
└──────────────────────────────────────────────────────────────────────────┘
```

**三种角色,职责不重叠**:桌面 UI(`clientId='local'`)、浏览器插件(`clientId='pulsemind-extension'`)、未来的 CLI/Web — 都是同一协议客户端。会话按 `clientId` 归属,事件只发给归属连接。

### 2.1 一次"点按钮"的完整时序(反向 RPC)

```
用户: "帮我把这个表单填了"
 扩展 → agent.ask{sessionId, content, pageContext:{url,title}}
 主进程: 引擎循环 → 模型返回 tool_use(page_get_content)
   hosted 代理: getTransport(sessionId) → conn
   主进程 → 扩展: tool.call{callId, tool:'page_get_content', args, timeoutMs:20000}
     扩展 background: sessionId→tabId → content script: buildDomTree() → 文本
   扩展 → 主进程: tool.result{callId, ok:true, result:"[1]<input …>"}
   结果回注 loop → 模型返回 tool_use(page_input)
   …（同上）…
 若该 tool_use 被审批梯子拦下:
   引擎 agentStatus = awaiting_approval
   hosted 路由 → 扩展: approval.request{callId= toolUseId, kind:'browser_write', summary}
   用户点「批准」→ 扩展 → 主进程: approval.response{callId, approved:true}
   主进程: engineCall(sessionId,'approveTool',[toolUseId]) → 恢复执行
 主进程 → 扩展: agent.event(messages_append / streaming_blocks / tool_status / done…)
```

---

## 3. 详细设计

### 3.1 协议补全(服务端 `ws-server.ts`)

方法名沿用 `src/shared/agent-protocol/methods.ts`,**不新增拼写**(该文件注释明确要求与 Anywhere 同名同义)。握手 `hello` 已有,`PROTOCOL_VERSION` 递增规则见 PLAN-0.3.5 §执行约定 2。

#### 3.1.1 客户端 → 服务端

| 方法 | params | result | 备注 |
|---|---|---|---|
| `hello` | `{clientId,clientVersion,protocolVersion}` | `{protocolVersion,serviceVersion}` | 已有。clientId 约定 `pulsemind-extension`;Anywhere 官方扩展用 `anywhere-extension` 也接受(便于 0.3.5 M4.1 兼容验证) |
| `session.create` | `{sessionId?, agentId?, title?, pageContext?}` | `{sessionId, agentId, resumed?}` | **新增 `sessionId`/`pageContext`**;传既有 id 且库里有会话 → 恢复(G4)。`pageContext.url/title` 作为初始 title 与未来站点路由输入 |
| `session.list` | `{limit?}` | `{sessions:[{sessionId,agentId,title,updatedAt}]}` | 插件侧"最近会话"用;数据源 `conversations where origin='extension'` |
| `session.delete` / `session.rename` | `{sessionId}` / `{sessionId,title}` | `{ok:true}` | 面板右键删除/重命名 |
| `agent.ask` | `{sessionId, content, pageContext?}` | `{accepted:true}` | 已有;**透传 pageContext**(G3)。正文走事件流,不在 result 里 |
| `agent.cancel` | `{sessionId}` | `{canceled:true}` | 已有 |
| `agent.history` | `{sessionId}` | `{messages, agentId}` | 已有;恢复路径先 `session.create` 再取历史 |
| `tool.result` | `{callId, ok, result?, error?}` | (通知,无 id) | **新增分发**;丢弃未知 callId 并记审计 |
| `approval.response` | `{callId, approved}` | (通知) | **新增**;超时/断连视为拒绝 |
| `ask_user.response` | `{callId, response}` | (通知) | **新增**;映射 `engineCall('respondToTool',[toolUseId, response])` |
| `iteration_limit.response` | `{approved}` | (通知) | **新增**;`approved` → `engineCall('extendLoop')`,否则 `stopExecution` |
| `ping` | — | `{pong,serviceTime}` | 已有 |

#### 3.1.2 服务端 → 客户端

| 方法 | params | 触发点 |
|---|---|---|
| `agent.event` | `{sessionId, data: AgentEventData}` | 已有;`session-manager.onEvent` 的现有事件面(§3.1.4) |
| `tool.call` | `{callId, sessionId, tool, args, timeoutMs}` | 引擎执行 hosted 工具时 |
| `approval.request` | `{sessionId, callId, kind, summary, detail?}` | `agentStatus.status === 'awaiting_approval'` 时,逐 tool 发;`callId = toolUseId` |
| `ask_user.request` | `{sessionId, callId, question}` | `awaiting_user_input` 时;`callId = toolUseId` |
| `config.changed` | `{scope}` | 可选(M-later):桌面改设置后通知插件刷新(如 token 重置) |

#### 3.1.3 分发面归属

`ws-server.ts` 的 switch 当前 6 个 case(`:117-173`)。补全后需要一张 **sessionId ↔ 连接** 的反查表(现在只有 `conn.sessions` 集合的顺查),供 hosted 代理与审批路由定位"这轮该问谁"。建议抽 `src/main/agent/client-registry.ts`:

```ts
interface ClientTransport {
  clientId: string
  sendToolCall(p: ToolCallParams): void
  sendApproval(p: ApprovalRequestParams): void
  sendAskUser(p: AskUserRequestParams): void
}
agentClientRegistry.bind(sessionId, transport)   // ask 开始时绑定,结束时解绑
agentClientRegistry.get(sessionId): ClientTransport | undefined
agentClientRegistry.isHostedCapable(sessionId): boolean   // 在线门控 G5 读它
```

**绑定时机 = 一次 `agent.ask` 的生命周期**(临时绑定),而非会话建连期常驻 —— 与 Anywhere `SessionManager` 的 `session.remote`(仅 busy 时存在)一致;这样"哪个连接发起的这轮"天然正确,多标签/多 profile 不串。

#### 3.1.4 事件面与插件端展示(PulseMind 事件比 Anywhere 丰富,需降级表)

| PulseMind 事件(`payloads.ts:103-122`) | 插件端展示 |
|---|---|
| `messages_append` / `messages` | **权威来源**:消息列表镜像(截断时收到全量,直接替换) |
| `streaming_blocks` | 进行中的流式气泡(打字机);与 messages 收敛后由后者接管 |
| `tool_status` | 工具卡就地更新(状态/exitCode/输出尾部) |
| `token` | 可选:无 `streaming_blocks` 时的降级打字机 |
| `status` | 状态行(thinking/executing/queued/error);`awaiting_*` 触发审批/问答卡 |
| `plan_update` | v1 折叠为一行「计划 n/m」;M4 做完整计划卡 |
| `spawn_progress` | 一行子代理进度 |
| `usage` | 会话角标(input/output tokens) |
| `done` / `error` | 收尾/错误横幅 |

插件不需要理解引擎内部结构:**只吃 `AgentMessage[]` 镜像 + 流式快照**,与桌面渲染层消费同一份协议,天然对齐。

### 3.2 服务发现与配对

#### 3.2.1 端口(G6)

- `SERVICE_DEFAULT_PORT = 8765`(`service-config.ts`),设置在 `settings.servicePort`。
- 冲突回退改为**确定性扫描**:`8765 → 8779` 依次尝试(EADDRINUSE 则 +1),全部占用才报错。改动点:`ws-server.ts:206-213` 与 `service-runtime.ts:36` 的 `port: 0` 两处。
- 插件侧发现顺序:① options 里手填的 URL → ② 扫描 8765–8779,对每个端口 `GET /`(服务已在回环应答 `{service:'pulsemind-agent',protocolVersion}`)→ 命中即用,结果缓存进 `chrome.storage.local`。
- 桌面设置页显示"当前端口"+「复制连接地址」按钮,人工兜底。

#### 3.2.2 token 配对(G7)

- 扩展首次连接:`GET http://127.0.0.1:<port>/token` → `{token}`。
- 服务端校验(双保险):请求 `Origin` 必须以 `chrome-extension://` 开头;**且** `Host` 必须是 `127.0.0.1`/`localhost`(防 DNS rebinding)。网页 fetch 无法伪造 Origin,故普通站点拿不到 token;非浏览器客户端本就能读 `~/.pulsemind/service-token`,不构成新增风险面。
- 失败/拒绝 → options 页手输 token(桌面设置页可复制)。
- token 重置(M2.4 已有)后:插件收到 `4401` 关闭码即清缓存、重新配对一次。

#### 3.2.3 桌面端未运行

面板显示未连接态 + 「启动 PulseMind 桌面端」指引;M5 可选:注册 `pulsemind://` 自定义协议由插件唤起(`app.setAsDefaultProtocolClient`),仍不做 native messaging 自启。

### 3.3 会话模型

| 维度 | 设计 |
|---|---|
| 粒度 | **一个标签页一个会话**(`tabId ↔ sessionId`),存 `chrome.storage.session`(SW 被杀不丢);同标签页跨导航复用(页面换了但话题连续) |
| 命名 | `sessionId` 由服务端生成(现状 `ws_<ts>_<uuid>`),插件不自己造 |
| 归属 | `clientId = pulsemind-extension`;`conversations.origin = 'pulsemind-extension'`(经 `updateConversationOrigin`) |
| 落库 | 复用 mainHost 的 `appendConversationMessages`(引擎自动落),与桌面会话**同一张表** —— 目的是复用既有的持久化与恢复链路,而非让桌面端看到它 |
| 桌面可见性 | **桌面端会话列表排除 `origin='pulsemind-extension'`**(裁定 3)。推论:面板必须是历史入口 → `session.list` / `session.delete` / `session.rename` 提前到 M1,不能留到 M4 |
| 恢复 | 桌面端重启/插件 SW 被杀:插件 `session.create{sessionId}`(服务端从库 hydrate)→ `agent.history` → 渲染 |
| 并发 | 服务端已有全局 2 路并发 + FIFO(`session-manager.ts:78`),插件只需展示 `status:'queued'` 队列位次 |
| 清理 | 标签页关闭 → `session.delete`?**不删**(会话是资产,关闭标签只解绑);面板提供显式删除 |

### 3.4 工具:page_* 系列(宿主转发型)

#### 3.4.1 与现有 `browser` 工具的关系(决策 D2)

桌面端已有 `browser` 工具(Playwright/WebContentsView,驱动**独立浏览器**,无用户登录态)。**不合并、不复用其后端**:

- 语义不同:`browser` = 代码驱动独立浏览器的完整能力(多标签/截图/locator);`page_*` = 用户**眼前那个标签页**的文本 DOM 操作(真实登录态、真实会话)。
- 若把扩展做成第三种 `BrowserService` 后端,就得实现 `playwright`(locator op)/`snapshot`(ariaSnapshot)等 Playwright 语义,浏览器内没有对应实现,只能假造 → 模型会拿到似是而非的结果。
- 命名隔离(`page_*`)后,配合**扩展会话的 `allowedTools` 白名单里没有 `browser`**,模型在任何单个会话里都只会看到一套浏览器工具,不存在选择困难。

#### 3.4.2 工具定义

| 工具 | 参数 | tier | 超时 | 说明 |
|---|---|---|---|---|
| `page_get_content` | `viewportExpansion?` | read | 20s | 重分析 DOM,返回带 `[index]` 的紧凑文本 + 滚动/截断提示。**每次操作后索引都会重建** |
| `page_scroll` | `down?`, `pages?`, `pixels?`, `index?` | read | 10s | 整页或指定容器滚动;随后需重新 `page_get_content` |
| `page_wait` | `seconds`(1–10) | read | 15s | 等待异步渲染 |
| `page_click` | `index` | write | 10s | W3C 事件序列;索引来自最近一次 `page_get_content` |
| `page_input` | `index`, `text` | write | 10s | 原生 value setter + 冒泡 `input`/`change`(兼容 React 受控组件) |
| `page_select` | `index`, `option` | write | 10s | 按 value/文本/label 匹配 option |
| `page_back` | — | write | 10s | `history.back()` |
| `page_execute_js` | `script`, `args?` | **exec** | 30s | 页面内求值;CSP 阻断时走 `chrome.debugger` 回退 |
| (M2.5 可选)`page_navigate` | `url` | write | 15s | 当前标签页跳转 |
| (M4 可选)`page_screenshot` | — | read | 10s | `captureVisibleTab` 返回图片给模型(需视觉模型) |

定义落点:`src/renderer/src/tools/built-in-tools.ts`(`category: 'page'`),`instructions` 落 `tool-instructions.ts`,门控摘要落 `builtin-gate.ts`,**并加入 `DEFAULT_ENABLED_TOOLS`**(`src/main/storage/tool-preferences-store.ts:4-33`)——该 store 对"默认开、但库里没有偏好行"的内置工具会自动补为启用(`get()` 的 `missing` 分支),所以老用户升级后也能看到页面工具。

#### 3.4.2.1 tier 与路由:不要把 page_* 塞进现有 tier 集合

现状里**分派路由与审批 tier 是同一套东西**:`READ_TIER_TOOLS` / `WRITE_TIER_TOOLS`(`execution-flow.ts:21-22`)既决定归类,又决定落到哪个执行器:

- `READ_TIER_TOOLS` → `execReadOnlyTools`(并行读,`tool-executors.ts:148`)
- `WRITE_TIER_TOOLS` → `execWorkspaceTool`(工作区文件写路径 + 备份,`tool-executors.ts:233`)
- 两者都不占 → `otherTools` → `execOtherTool`(`tool-executors.ts:492`),且被 `held.has('exec')` 拦下 = **`outside-ask` 起就要审批**

所以**不能**把 `page_click` 加进 `WRITE_TIER_TOOLS`——它会被 `execWorkspaceTool` 当成文件写处理。正确做法:

1. 新增独立的 `tierOfTool(name): SandboxToolTier` 纯函数(建议放 `src/shared/` 或 `agent/engine/tool-tiers.ts`),把"审批层级"从"执行路由"里拆出来;
2. 新增 `isPageTool` 归类:页面工具自成一派(仿 `memoryTools`/`systemTools` 的现有写法),分派到 `execPageTool`;只读的 `page_get_content`/`page_scroll`/`page_wait` 可走并行,写操作串行;
3. 审批集合按 tier 组装:`page_click`/`page_input`/`page_select`/`page_back`/`page_navigate` = `write`(仅 `always-ask` 拦);`page_execute_js` = `exec`(`outside-ask` 起拦)。

#### 3.4.2.2 页面工具必须补齐的**两个**路由点

`browser` 当年作为 system tool 分派,因此**从不被审批梯子拦下**(已知遗留:`execution-flow.ts:204` 的 `isSystemTool` 含 `browser`,而 held 集合不含它)。页面工具要真正受控,以下两处都得改:

| 站点 | 位置 | 不改的后果 |
|---|---|---|
| 分派归类 | `dispatchToolExecution`(`execution-flow.ts:201-243`) | 归入 `otherTools` → 走 `execOtherTool` → 未知工具报错 |
| **审批通过后的执行** | `approveTool`(`execution-flow.ts:48-90`) | **兜底分支是"Shell execution (default)"** → 被批准的页面工具会被当成 shell 命令执行 |

`approveTool` 那一处最容易被漏:`memory`/`WRITE_TIER`/`MCP`/`spawn_agent`/`ask_user` 之后就是 shell 兜底,必须插入 `isPageTool → execPageTool` 分支。

好消息是**超限参数路径不需要单独改**:`validateToolParams` 剔除超限工具后,剩余工具仍调同一个 `dispatchToolExecution`(`execution-flow.ts:266-282`),归类逻辑是共享的。另需为页面工具登记参数长度上限(`TOOL_PARAM_LIMITS`,`engine-constants.ts:17-21`),例如 `page_execute_js.script`、`page_input.text`,避免模型一次塞进巨大字符串。

#### 3.4.3 执行链路(服务端 → 扩展)

```
ToolExecutor.execPageTool()                       // 仿 execBrowser(tool-executors.ts:432-457)
  → getHost().hostedToolCall(tool, args, {sessionId, timeoutMs})
      · mainHost 实现:查 agentClientRegistry.get(sessionId)
      · 无绑定 → 抛错「当前会话没有连接的浏览器客户端」(回注 is_error,loop 不阻塞)
  → hosted 代理:pending.set(callId= toolUseId, {resolve,timer,onAbort})
      → transport.sendToolCall({callId, sessionId, tool, args, timeoutMs})
  ← 扩展 tool.result{callId, ok, result|error}
      · settle():清 pending、解 resolve/reject
      · 迟到/未知 callId → 丢弃 + 写 audit_log
      · 超时 → 回注 is_error「工具超时,请重试或换一种方式」
```

细节规则(照抄 Anywhere §7.4 + PulseMind 既有惯例):
- **参数体积防线**:沿用既有 `validateToolParams`(`result-ingestion.ts:86-108`)+ `MAX_TOOL_INPUT_JSON_BYTES = 1MB`(`engine-constants.ts:22`),并给页面工具补 `TOOL_PARAM_LIMITS` 条目;
- **结果截断**:页面文本按全局 guardrail(4000 tokens)截断,超限提示模型滚动后再取;
- **只读并行/写串行**:hosted 工具沿用现有分流(`readOnly: true` 的 `page_get_content` 走并行队列);
- **取消**:`agent.cancel` 的 AbortSignal 贯穿到 hosted 代理,onAbort 立刻 reject 并向扩展发 `tool.cancel`(可选)或让扩展自行丢弃;
- **页面已关闭**:扩展侧 `sessionId→tabId` 找不到 → 直接回 `{ok:false, error:'标签页已关闭'}`,服务端不阻塞。

`PulseHost` 需要新增一个方法名(`hostedToolCall`),落点五处:`agent/host/types.ts`、`agent/host/index.ts`(渲染 Host 抛"无客户端")、`main-host.ts`(真实现)、`preload/index.ts` + `types/electron.d.ts`(声明,桌面渲染层不会调用但需类型自洽)。

#### 3.4.4 在线门控(G5)

扩展不在线时,`page_*` 必须从模型视角消失(Anywhere 的验收原话:"扩展离线时模型看不到 browser 工具")。

- 判定:`agentClientRegistry.isHostedCapable(sessionId)`。
- 注入点:`collectEnabledTools`(`tool-collection.ts`)在 gated 过滤前,用 `deps.opts.hostedTools` / 或 `deps.opts.hostedAvailable: boolean` 把 `category === 'page'` 的工具整体剔除。引擎选项由 `session-manager.doCreateSession`/`refreshOptions` 按当前绑定状态设置(会话创建时扩展在线才有)。

#### 3.4.5 DOM 管线移植(核心资产)

直接移植 `../Anywhere/packages/extension/src/content/dom-tree.ts`(598 行)+ `common/js-exec.ts`,要点保留:

1. `buildDomTree(root, {viewportExpansion}) → {text, selectorMap: Map<number, Element>}`;索引每次重建,`selectorMap` 存**直接 DOM 引用**(无 xpath)。
2. 可见性:`offsetWidth/Height` + computed style;`isTopElement` 用 `elementFromPoint` 中心+两角命中判定,被遮挡元素不编号。
3. 可交互判定:computed `cursor` 最优信号 + 交互标签 + ARIA/role + class 启发式 + 可滚动容器;`isDistinctInteraction` 防父子重复编号。
4. 序列化:`[index]<tag attr=val>text />`,tab 缩进表达层级;属性白名单 + 去重 + 20 字符截断;`MAX_NODES = 4000`。
5. 穿透:`element.shadowRoot` 保留递归穿透(Anywhere 已验证);iframe **不跨 frame 路由**(v1 所有工具调用都打 `frameId: 0`,同文档内的 iframe 元素能分析到就分析,同源跨 frame 的读写留待后续)。
6. 新元素标记 `*[index]`(WeakMap),**按 session+URL 隔离**(Anywhere 的已知坑:跨页面会串)。
7. 页面内自注入元素必须跳过(我们的浮层 root id 前缀加入 skip 名单,避免 agent 索引到自己)。

### 3.5 审批与安全

| 面 | 设计 |
|---|---|
| 审批梯子 | 复用 `requiresApproval(mode, tier)`;模式来自会话(浏览器会话新会话默认 `auto`,用户可在面板上切 `outside-ask`/`always-ask`,写 `conversations.approval_mode`) |
| 路由 | `awaiting_approval` → 只发给**该会话来源客户端**(扩展面板);**桌面端不弹**(它没绑定这轮),避免双弹/漏弹 |
| 超时 | 扩展审批 120s、问答 300s(Anywhere 取值);超时 = 拒绝,回注 `is_error` 并让模型换路径 |
| 断连 | 连接断开时,该会话所有 pending 审批/工具立即以"拒绝/失败"结算,不留悬空 |
| 逐次 vs 信任 | 面板顶部提供「本会话信任本页」开关(= 切 `auto`),对高频点击场景避免逐次确认 |
| 页面数据 | 页面文本**只随用户发起时上传**;默认**不写入长期记忆**(扩展会话默认关闭 `afterSession` 记忆提取,设置里可开);记忆提取前过敏感正则黑名单(PLAN-0.3.5 M4.3) |
| 传输 | 仅回环 + token(G1 之外新增 Origin 白名单 G8);`GET /token` 限定扩展来源 |
| 标签页边界 | `page_*` 只作用于该会话绑定的 `tabId`;不做跨标签读取(避免"读你所有标签页"的隐私爆炸) |
| 审计 | 每次 hosted 工具调用 / 审批 / 拒绝写 `audit_log`(表已存在),桌面端可查"哪个站点、何时、调了什么" |
| exec 层 | `page_execute_js` 默认**启用但归 exec 层**;设置里可全局禁用(企业/敏感场景) |

### 3.6 扩展工程

**目录(新增 `src/extension/`)**

```
src/extension/
├── manifest.json                 # MV3
├── background/
│   ├── index.ts                  # 装配:alarms/action/commands
│   ├── ws-client.ts              # 移植:握手/退避/pending/超时
│   ├── client.ts                 # 连接工厂 + 通知分发
│   ├── discovery.ts              # 端口扫描 + /token 配对(新)
│   ├── state.ts                  # tabId↔sessionId、panel 状态(storage.session)
│   ├── tool-router.ts            # tool.call → tab → content → tool.result
│   └── cdp.ts                    # execute_js 的 CSP 回退
├── content/
│   ├── index.ts                  # 浮层宿主:FAB + Shadow DOM 挂载 + 展开状态
│   ├── page-tree.ts              # 移植 dom-tree.ts
│   ├── page-tools.ts             # 移植 dom-tools.ts(改名 page_*)
│   └── bridge.ts                 # port 通道:EVENT/TOOL_CALL/…
├── ui/
│   ├── App.tsx                   # 会话面板
│   ├── useSession.ts             # 事件归约 → 消息镜像(§3.1.4)
│   ├── Transcript.tsx / Composer.tsx
│   ├── cards/{ApprovalCard,AskUserCard,IterationCard}.tsx
│   └── styles.css                # 注入 Shadow Root 内,不经页面
└── options/{index.html,index.ts}
```

(M4 再加 `sidepanel/{index.html,index.tsx}` 作为第二入口。)

**构建**:新增 `scripts/build-extension.js`(esbuild,`platform:'browser'`,`format:'iife'`,`target:'chrome114'`,`jsx:'automatic'`),入口 background / content / options(M4 加 sidepanel),`copyFile` manifest.json + icons → `out/extension/`。新增 `tsconfig.extension.json`(DOM lib + `@types/chrome`,`references` 到 shared),把 `src/extension/**` 纳入类型检查。与既有 `scripts/build.js`(main/preload/node)/Vite(renderer)三者并列,互不干扰。

**协议类型复用**:插件 `import type { Methods, ErrorCodes, ToolCallParams, AgentEventData, … } from '@shared/agent-protocol'`(仅类型 + 常量;`payloads.ts` 对 `sandbox/policy` 是 type-only 引用,esbuild 会完全擦除,不会把主进程代码带进浏览器包)。消息模型类型(`AgentMessage`/`ContentBlock`)type-only 引 `src/renderer/src/types/agent.ts`(AGENTS.md 已声明这些目录为 de-facto 共享代码)。

**manifest 权限(v1 最小集)**

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "tabs", "alarms", "scripting"],
  "host_permissions": ["http://127.0.0.1/*", "http://localhost/*", "<all_urls>"],
  "optional_permissions": ["debugger"],          // 仅 execute_js 的 CSP 回退按需申请
  "background": { "service_worker": "background.js" },
  "options_page": "options.html",
  "commands": { "open-panel": { "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" } } },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle" }],
  "web_accessible_resources": [{ "resources": ["assets/*"], "matches": ["<all_urls>"] }]
}
```

(面板不需要 web-accessible 的 JS/CSS —— 它在隔离世界的 Shadow Root 里;`assets/*` 只给图标等静态资源。)

**权限取舍(裁定 5)**:FAB 常驻 `<all_urls>` 注入,换来"每次开页浮层就在"。代价是安装提示会显示"读取并更改你访问的所有网站上的数据",因此隐私说明必须写清三条边界,且**实现要能兑现**:①content script 常驻但**不主动上传任何页面内容**;②页面文本只在用户发起对话、或模型调用 `page_get_content` 时上传;③浮层 UI 走 Shadow DOM,页面自身读不到也改不动。若日后要收紧,可平滑切到"按需注入 + 站点白名单"(结构不变,只改 manifest 与一个开关)。`sidePanel` 权限随 M4 的第二入口再引入。

**SW 生命周期**:`chrome.alarms`(≥30s,Chrome 下限 0.5min)唤醒+保活;SW 被杀视为正常,唤醒后 `connect()` → `hello` → 恢复会话(服务端是权威状态,插件侧无状态可丢 —— 这是相对 Anywhere 的结构性优势)。可选加强:offscreen document 持长连(M-later,先不做)。

**UI 形态(决策 D3,裁定 1)**:v1 = **页面内浮层** —— FAB + 浮层,React **直接跑在 content script 的隔离世界**,挂进一个 **Shadow Root**(页面 CSS 进不来,我们的样式也不污染页面)。这一条同时消掉两个坑:

- **面板本身绕过 CSP**:不需要 Anywhere 那套"注入第二个 bundle 到页面主世界 + CustomEvent 中继",因为 React 就在 content script 里,天然持有 `chrome.runtime` 通道;只有 `page_execute_js`(要在**页面上下文**求值)才仍受站点 CSP 约束,走 `chrome.debugger` 回退。
- **样式隔离无需额外机制**:Shadow DOM 本身就是隔离边界,`styles.css` 注入 Shadow Root 即可。

已知代价:**页面导航会重建浮层**,由 content script 重挂 + `chrome.storage.session` 中"该 tab 是否开着面板"决定是否自动展开;FAB 与浮层节点必须加入 DOM 管线的 skip 名单(否则 agent 会索引到自己)。M4 再补侧边栏(Chrome 自带 `sidePanel`,页面不是网页时仍可用)作为第二入口 —— **同一份 `ui/App.tsx` 两种宿主**,不 fork。

### 3.7 桌面端配套改动

| 改动 | 位置 |
|---|---|
| 服务设置页新增「浏览器插件」卡:连接状态 / 在线 clientId 列表 / 端口 / 「复制连接地址」「复制 token」/ 扩展目录「在访达中显示」 | `components/.../SettingsPage.tsx` 服务体系 + `ipc/service.handler.ts` |
| 会话列表**排除**扩展会话 | 会话列表查询加 `WHERE COALESCE(origin,'local') <> 'pulsemind-extension'`(裁定 3) |
| 新增 `GET /token`、Origin 白名单、确定性端口扫描 | `ws-server.ts` / `service-runtime.ts` |
| 打包把插件产物放入 `resources/extension/`(便于"在访达中显示") | `package.json` build 配置 + `scripts/build-extension.js` |

---

## 4. 里程碑与实施顺序

> 每个任务完成后:`npm test` + `npx tsc -p tsconfig.node.json --noEmit` + `-p tsconfig.web.json --noEmit`(+ 新增 `-p tsconfig.extension.json --noEmit`)对基线只降不升;一任务一提交。

### M0 服务端协议补齐 + 插件骨架(无 UI 也能验收) ✅ 2026-09-14

- [x] **M0.1 客户端注册表与 transport**:新增 `src/main/agent/client-registry.ts`;`agent.ask` 生命周期内绑定/解绑 transport
- [x] **M0.2 反向 RPC**:`src/main/agent/hosted/{proxy,prompts}.ts`(+`service-sessions.ts` 注入缝隙);`tool.call`/`tool.result` 分发、pending map、逐工具超时、孤儿丢弃 + 审计;`awaiting_approval`/`awaiting_user_input` → `approval.request`/`ask_user.request`(callId=toolUseId,超时=拒绝)
- [x] **M0.3 端口发现与配对**:确定性扫描 8765–8779(注意 `ws` 会把 httpServer 的 error 转发到 wss,两端都要挂监听);`GET /token`(Origin 限定 + Host 回环);连接层拒绝网页 Origin(4403)
- [x] **M0.4 会话补全**:`session.create` 支持恢复既有 sessionId(`store.hydrate`)、`session.list/delete/rename`(按 clientId 隔离,跨客户端 forbidden)、`agent.ask` 透传 pageContext(→ 引擎 opts → 提示词动态 Current Page 段);status 事件携带 `tools`(StatusToolInfo);桌面会话列表 SQL 排除 hosted origin(裁定 3)
- [x] **M0.5 插件骨架**:`src/extension/`(manifest + background{config,discovery,ws-client,index} + options)+ `scripts/build-extension.js` + `tsconfig.extension.json`(root references 已挂);`npm run build:extension` 出包 `out/extension/`,可加载已解压;SW 自动发现+配对,options 显示连接状态
- **验收结果**(tests/agent-protocol-ws.test.ts,14 用例):网页 Origin 拒 4403 / 扩展 Origin 与裸客户端放行;GET /token 三态(扩展 200、网页 403、异 Host 403);端口被占在 +1..+14 内确定性回退;resume=true 且 hydrate;ask 透传 pageContext 并经 tool.result 完成;200ms 超时回注错误且 transport 解绑;孤儿 tool.result 无害;approval/ask_user/iteration_limit 往返;session.list/rename/delete 按 origin 隔离;提示词含/不含 Current Page;全量 346 测试绿;三套 tsc 我方文件零错误(DB 依赖用例走注入 store,better-sqlite3 Electron-ABI 无法在 vitest 加载为既有已知缺口)

### M1 页面内浮层 + 流式对话打通

- [ ] **M1.1 消息镜像与渲染**:`ui/useSession.ts` 按 §3.1.4 归约 `messages_append`/`streaming_blocks`/`tool_status`;Markdown 渲染
- [ ] **M1.2 浮层宿主(裁定 1/5)**:FAB + Shadow Root 挂载(React 在隔离世界,无需二次注入)+ 导航后重挂与展开状态持久化;自注入节点加入 DOM 管线 skip 名单
- [ ] **M1.3 输入与生命周期**:发送/停止(`agent.cancel`)/重连提示/`queued` 队列位次;`tabId↔sessionId` + `chrome.storage.session` 持久化
- [ ] **M1.4 会话恢复与历史**:SW 唤醒与桌面重启后 `session.create{sessionId}` + `agent.history` 回填;**面板内会话列表**(`session.list`/`delete`/`rename`)——桌面端看不到这些会话(裁定 3),面板是唯一入口,故不在 M4
- [ ] **M1.5 桌面配套**:服务设置页「浏览器插件」卡(连接状态/端口/token/在线客户端);会话列表排除扩展会话
- **验收**:任意网页打开浮层连续对话,页面刷新与桌面端重启后上下文不丢;浮层在主流站点不被页面 CSS 破坏;桌面会话列表**不出现**扩展会话,而浮层内可切换历史会话

### M2 页面工具(看 / 点 / 填)—— 价值拐点

- [ ] **M2.1 DOM 管线移植**:`page-tree.ts` + fixture 测试(移植 Anywhere `test/dom-tree.test.ts`)
- [ ] **M2.2 `page_*` 工具定义 + tier/路由改造**:`built-in-tools.ts` / `tool-instructions.ts` / `builtin-gate.ts` / `DEFAULT_ENABLED_TOOLS`;抽出 `tierOfTool`,补齐 `dispatchToolExecution` / 超限旁路 / **`approveTool` 兜底** 三处路由点(§3.4.2.1–§3.4.2.2)
- [ ] **M2.3 执行链路**:`hostedToolCall` 五处落点 + `ToolExecutor.execPageTool` + content script `page-tools.ts` + `tool-router.ts`
- [ ] **M2.4 在线门控**:扩展离线 → `page_*` 从工具表消失
- [ ] **M2.5 扩展会话白名单**:`allowedTools = page_* + ask_user`(会话创建时注入),确认模型看不到 `browser`/`exec`/`write`
- **验收**:面板里说"总结这个页面"能拿到内容;说"把这个表单填了"能点到/填对;下拉/滚动/等待可用;扩展掉线时模型不再尝试页面工具并给出可解释的失败

### M3 审批与隐私

- [ ] **M3.1 审批路由**:`awaiting_approval` → `approval.request`(callId=toolUseId)→ `approval.response` → `engineCall('approveTool'|'rejectTool')`;120s 超时=拒绝;断连立即结算
- [ ] **M3.2 问答与续跑**:`ask_user.request/response`、`iteration_limit.response`(`extendLoop`/`stopExecution`)
- [ ] **M3.3 面板授权开关**:逐次确认 / 本会话信任本页(`auto`)/ 完全只读
- [ ] **M3.4 隐私红线**:扩展会话默认关闭记忆提取;页面内容不入 `MEMORY.md`;敏感过滤钩子;审计写入
- **验收**:写操作在 `always-ask` 下必须经面板批准;拒绝后模型能改道;审计日志可查

### M4 第二入口与体验打磨

- [ ] **M4.1 侧边栏第二入口(可选)**:Chrome `sidePanel` + 同一份 `ui/App.tsx`;两处入口共享同一会话
- [ ] **M4.2 多标签与切换**:切标签提示、标签关闭解绑、会话归属可视化
- [ ] **M4.3 丰富事件降级**:`plan_update` 计划卡、`spawn_progress`、`usage` 角标、错误重试
- [ ] **M4.4 可选增强**:`page_screenshot` / `page_navigate` / 下载与上传路径处理
- **验收**:两处入口会话一致;切标签不串会话;计划/用量/子代理进度可读

### M5 品牌、打包与分发

- [ ] **M5.1 品牌**:图标、名称、`EXTENSION_CLIENT_ID` 常量、i18n(zh/en)
- [ ] **M5.2 打包**:`out/extension/` 产物 → `resources/extension/`;桌面设置页「在访达中显示」+ 加载指引
- [ ] **M5.3 版本与协议对齐**:`clientVersion` 上报;`PROTOCOL_VERSION` 不匹配时的用户可读提示(已握手机制)
- [ ] **M5.4(可选)未连接体验**:注册 `pulsemind://`(`app.setAsDefaultProtocolClient`),浮层未连接态给「启动 PulseMind」按钮(裁定 7)
- [ ] **M5.5(可选)商店发布**:隐私说明(读页面/操作页面/仅回环/何时上传)、审核材料
- **验收**:新人按指引 3 步装好并连上;版本不匹配给出明确升级提示;桌面端未运行时能一键唤起

---

## 5. 测试策略

| 层 | 手段 |
|---|---|
| 协议分发 | `tests/agent-protocol-ws.test.ts`:起真服务 + Node `ws` mock 客户端 → hello/版本不符/错 token/网页 Origin 拒绝/会话增删/ask/event/cancel |
| 反向 RPC | `tests/hosted-tools.test.ts`:tool.call 往返、超时回注、孤儿结果丢弃、客户端离线门控、审批超时=拒绝、断连结算 |
| DOM 管线 | `tests/extension/dom-tree.test.ts`(移植 Anywhere fixture:常见组件库 / SPA / shadow DOM / 大页面截断 / 索引稳定性),jsdom 环境 |
| 事件归约 | 插件 `useSession` 纯函数化后单测:乱序/截断/重复事件的镜像正确性 |
| 端到端(手工) | 真实 Chrome + 桌面端:开面板 → 对话 → 看页面 → 点/填 → 审批 → 断线重连 → 桌面端继续 |

---

## 6. 风险与备选

| 风险 | 影响 | 对策 |
|---|---|---|
| MV3 SW 30s 休眠 | 连接断、事件丢 | 服务端为权威状态,唤醒即 `hello`+恢复;alarms 保活;必要时 offscreen 持连 |
| 站点 CSP 阻断页面上下文求值 | `page_execute_js` 失效(面板本身不受影响,见 §3.6) | `chrome.debugger` 回退(按需授权);回退不可用时明确报错,不静默失败 |
| 页面 CSS 污染浮层 / 浮层污染页面 | UI 被页面样式破坏,或站点被我们改坏 | **M1 就会遇到**:Shadow Root 全隔离(双向);自注入节点进 DOM 管线 skip 名单,避免被 agent 索引到 |
| 常驻 `<all_urls>` 的审核与信任成本 | 安装提示较吓人、商店审核更严 | 裁定 5 已接受;隐私说明写清三条边界并在实现上兑现;保留"按需注入 + 站点白名单"的切换缝 |
| 端口发现失败 | 连不上 | 确定性扫描 + 手动覆盖 + 桌面端显示端口/一键复制 |
| 审批错弹/漏弹 | 安全或体验事故 | 审批只发给会话来源客户端;超时=拒绝;断连即结算;审计留痕 |
| token 泄漏 | 本地服务被滥用 | 回环 + Origin 限定 + Host 校验;`/token` 只认扩展来源 |
| 大页面 token 爆炸 | 成本/上下文溢出 | 4000 节点上限 + 滚动分片提示 + 全局 guardrail 截断 |
| 两套浏览器工具概念混淆 | 模型选错工具 | 扩展会话白名单内**只**有 `page_*`;prompt 中两者描述互斥 |
| 与桌面端 Playwright 浏览器能力重叠 | 维护分摊不清 | 边界写进 `tool-instructions`:独立浏览器 vs 用户当前标签页 |

**备选方案**
- **插件直连 LLM(离线单机)**:不采纳(D1),避免双实现与凭据下沉。
- **Native messaging 自启服务**:可作 M5+ 增强,先做手动/协议唤起。
- **把扩展做成 `BrowserService` 第三种后端**:不采纳(D2),Playwright 语义无法诚实实现。

---

## 7. 非目标(本期不做)

1. 插件内运行 agent 循环 / 脱离桌面端使用。
2. 截图与视觉理解(v1 纯文本 DOM;`page_screenshot` 留作 M4 可选)。
3. 跨 iframe / 多 frame 工具执行(v1 仅顶层 frame)。
4. Firefox / Safari(v1 Chrome + Edge;manifest 与协议不留死结)。
5. 在插件里复用桌面端 React 聊天组件:运行环境(扩展页 vs Electron 渲染进程)与依赖(stores/IPC)完全不同;**保持一致的是消息模型与协议,不是组件**(AGENTS.md「界面复用」红线针对的是桌面端内部新造对话 UI,此处不适用)。
6. 站点级实例路由 / 每站点独立实例(PLAN-0.3.5 M5 的范畴;本 Plan 只保留 `pageContext.url` 作为输入)。
7. 在插件里配置 LLM/API Key(凭据只在桌面 `settings.json`)。

---

## 8. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 插件不做 agent 宿主,仅协议客户端 | 复用桌面端成熟能力;避免双实现漂移与凭据下沉(§1.4) |
| D2 | 新增 `page_*` 工具族,不并入 `browser`、不做第三种 BrowserService 后端 | 语义不同(独立浏览器 vs 当前标签页);Playwright 语义无法在浏览器内诚实实现 |
| D3 | **首发页面内浮层**(FAB + Shadow Root + 常驻注入),M4 补侧边栏第二入口(同一份 UI) | 裁定 1:视觉上"就是页面里的助手";代价是样式隔离与导航重挂进入 M1 范围 |
| D4 | 一标签页一会话,会话落 `conversations`(origin 标记),**桌面端列表排除** | 复用持久化与恢复链路;裁定 3 要求桌面端不被打扰,推得"面板必须是历史入口"|
| D5 | 常驻 `<all_urls>` content script(FAB 常在) | 裁定 5:体验优先。隐私边界写进说明且实现兑现(不上传页面、按需取 DOM、Shadow DOM) |
| D6 | 端口确定性扫描 + `GET /token` 自动配对 | 现在随机端口导致插件无法发现;配对要一步到位 |
| D7 | 页面内容默认不进长期记忆;扩展会话默认关记忆提取 | 隐私红线(PLAN-0.3.5 M4.3) |
| D8 | 扩展会话用 `allowedTools` 白名单(`page_*` + `ask_user`) | "轻量"落地;同时消除双浏览器工具的概念混淆 |
| D9 | 移植 Anywhere 的 DOM 管线与 WS 客户端骨架,UI 重写 | 598 行 DOM 树是已验证资产;UI 与事件面必然不同 |

---

## 9. 已裁定(2026-09-14)

| # | 议题 | 结论 | 落到文档 |
|---|---|---|---|
| 1 | 首发界面形态 | **页面内浮层**(FAB + Shadow Root) | §0.5、§3.6、M1.2、D3 |
| 2 | 页面工具命名 | **`page_*`** | §3.4、D2/D8 |
| 3 | 扩展会话是否进桌面列表 | **不进**(桌面列表按 origin 排除) | §3.3、§3.7、M1.4、D4 |
| 4 | `page_execute_js` 默认 | **默认启用,归 exec 层**(`outside-ask` 起需审批) | §3.4.2、D8 |
| 5 | FAB 注入权限 | **常驻 `<all_urls>` content script** | §3.6 manifest、D5、§6 风险 |
| 6 | 代码起点 | **移植 Anywhere 资产**(DOM 管线/WS 客户端/state/tool-router/cdp),UI 与工具层重写 | §1.3、D9 |
| 7 | 桌面端未运行 | **M5 可选项**:注册 `pulsemind://` 一键唤起 | §3.2.3、M5.4 |

遗留待定(不阻塞 M0,实施到对应里程碑前再定):

1. 浮层默认位置与尺寸;FAB 是否允许用户拖动并记住位置(涉及 DOM 管线 skip 与 storage 结构)。
2. 浮层展开状态是否跨会话记忆(`chrome.storage.session` vs `local`)。
3. 面板内的授权开关形态:三档(逐次确认 / 本会话信任本页 / 完全只读)是否为最终交互。
