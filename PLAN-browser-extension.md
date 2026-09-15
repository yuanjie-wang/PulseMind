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
│   ├── index.tsx                 # 浮层宿主:FAB + Shadow DOM 挂载 + 展开状态
│   │                             #  + 以 text 内联注入 ui/styles.css 与 x-markdown light 主题
│   ├── page-tree.ts              # 移植 dom-tree.ts
│   ├── page-tools.ts             # 移植 dom-tools.ts(改名 page_*)
│   ├── page-js.ts                # 求值 + 结果序列化
│   └── bridge.ts                 # port 通道:EVENT/TOOL_CALL/…
├── ui/
│   ├── App.tsx                   # 面板外壳:FAB / header / 横幅 / 会话列表
│   ├── usePanel.ts               # 事件归约 → 消息镜像(§3.1.4)+ 授权档位
│   ├── Transcript.tsx            # 消息流 ← components/chat/TranscriptView
│   ├── MessageBlocks.tsx         # 各块渲染 ← MessageGroup/SegmentView/CommandCard/ErrorDisplay
│   ├── Composer.tsx              # 输入卡 + 授权下拉 ← Composer/InputArea
│   ├── icons.tsx                 # 内联 antd 图标 d 数据(content script 不 import antd)
│   ├── format.ts                 # toolBlockSummary / 耗时 / Token 的逐字副本
│   ├── markdown.ts               # 转义优先的渲染器 + GFM 表格/嵌套列表
│   └── styles.css                # 注入 Shadow Root 内,不经页面;每条规则注明 renderer 出处
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
- **验收结果**(tests/agent-protocol-ws.test.ts,14 用例):网页 Origin 拒 4403 / 扩展 Origin 与裸客户端放行;GET /token 三态(扩展 200、网页 403、异 Host 403);端口被占在 +1..+14 内确定性回退;resume=true 且 hydrate;ask 透传 pageContext 并经 tool.result 完成;200ms 超时回注错误且 transport 解绑;孤儿 tool.result 无害;approval/ask_user/iteration_limit 往返;session.list/rename/delete 按 origin 隔离;提示词含/不含 Current Page;全量测试绿;三套 tsc 我方文件零错误(DB 依赖用例走注入 store,better-sqlite3 Electron-ABI 无法在 vitest 加载为既有已知缺口)

### M0.6 连接缺陷修复:插件"始终连不上" ✅ 2026-09-15

> 现场:options 一直显示「未连接(ws://127.0.0.1:8765,状态 closed)」。先用 Node 探针复现插件握手路径(扩展 Origin + 正确 token)证明**服务端完全正常**(liveness/`GET /token`/`hello` 三态均 OK),缺陷 100% 在插件侧。

- [x] **根因(致命)**:`WsClient.request()` 的门禁写成 `!socket || !this.helloDone`,而 `helloDone` 要等 hello **响应回来**才置位——hello 本身也要走 `request()` 发送,于是 hello 永远被自己的门禁以 `not connected` 拒绝 → teardown → 重连 → 再拒绝,死循环。修复:门禁放行 `hello` 自身(`!helloDone && method !== 'hello'`)。
- [x] **同类隐患**:alarm 每 30s 直接 `state.client.connect()`,会"复活"已被 `close()` 的旧客户端对象;`ensureClient()` 无并发保护,SW 冷启动 + `onInstalled` + alarm + options 重连可能并发造出多个同 clientId 客户端 → 服务端反复踢旧连接(4409)形成踢连战争。修复:alarm 统一走 `ensureClient()`;`ensureClient` 加 in-flight 串行化 + `forceRediscover` 合并为一次补跑;`close()` 清掉重连定时器(定时器不再复活手工关闭的客户端)。
- [x] **可诊断性**:`WsClient` 记录 `lastError`/`lastCloseCode`(服务端 4401/4403/4409 提为 `CloseCodes` 常量,两端共用一个源);`connect()` 的 ready promise 在失败时也落定(原来永不 settle);options 状态行显示失败原因,SW 打印连接迁移;收到 4401 自动清 token 并重新配对(一次性,防抖)。
- **回归测试**(tests/extension-ws-client.test.ts,5 用例,mock WebSocket):握手成功、握手前业务请求被拒且握手后放行、hello 被拒时 ready promise 落定并记录原因、4401 关闭码记录、手工 close 抑制重连并结算在途请求。**已验证这 5 个用例在旧代码下全部失败、在修复后全绿**——即该缺陷此前无法被发现。


### M1 页面内浮层 + 流式对话打通 ✅ 2026-09-15

- [x] **M1.1 消息镜像与渲染**:事件归约**复用桌面同一份 reducer**——把 `session-mirror`/`session-messages` 从 `src/renderer/src/utils/` 下沉到 `src/shared/agent-session/`(3 处渲染层调用点 + 1 处测试改引用),插件 `ui/usePanel.ts` 直接吃 `applySessionEvent`,不写第二套协议解释;`ui/markdown.ts` 是无依赖渲染器(先转义再生成标签、href 过 scheme 白名单)
- [x] **M1.2 浮层宿主(裁定 1/5)**:`content/index.tsx` 建宿主元素 + Shadow Root(样式以 `text` loader 内联注入,页面 CSS 进不来/我们不污染页面);React 直接跑在隔离世界,无需二次注入;CSP 不涉及面板自身。宿主标 `data-pulsemind-panel`,供 M2 DOM 管线 skip;上次展开状态存 `chrome.storage.session`,页面导航/刷新后按快照恢复
- [x] **M1.3 输入与生命周期**:`bridge.ts` 定义面板 ↔ worker 的消息契约(`panel/ask|cancel|attach|set-open|…`);发送/停止(停止走 `agent.cancel`)、未连接横幅 + 打开设置、Enter/Shift+Enter、流式光标;`tabId↔sessionId` 双向映射 + 面板开关均落 `chrome.storage.session`(SW 被杀不丢)
- [x] **M1.4 会话恢复与历史**:`background/panel-bridge.ts` 承接会话生命周期——`attach` 时先 `session.create{sessionId}`(服务端 hydrate)再 `agent.history` 回填,id 已被删除时跟随服务端返回的新 id 重新绑定;面板内会话列表 `session.list`/`delete`/`rename` + 新会话
- [x] **M1.5 桌面配套**:`SERVICE_GET_STATUS` 增加 `clients`(`ws-server` handle 新增 `clients()`)/`wsUrl`/`extensionDir`;`EnvironmentSettings` 增加「浏览器插件」卡(在线客户端 / 复制连接地址 / 加载指引 + 打开扩展目录);会话列表排除扩展会话沿用 M0.4
- **验收结果**:`tests/extension-markdown.test.ts`(7)+ `tests/extension-panel-bridge.test.ts`(10,fake chrome + fake client)+ `tests/extension-ws-client.test.ts`(5)全绿;全量 390 测试 44 文件绿;三套 tsc 我方文件零错(extension 0);`npm run build` + `npm run build:extension` 均通过(content.js 294KB,React 走 production build)
- **联调验证(真机跑插件代码)**:用 esbuild 把 `discovery + ws-client + panel-bridge` 打到 Node,配 fake chrome 连**正在运行的桌面端**:新建会话 → 全新 bridge(SW 重启模拟)`attach` 恢复**同一个** sessionId → 事件只推给绑定 tab → 删除后解绑。未跑真实模型(避免动用户的额度),`agent.ask` 的流式行为留待手动验收
- **过程中发现并修掉的两个真实缺陷**(都不在插件侧):
  1. `panel-bridge.snapshot` 原来只调 `agent.history` 不先 `session.create`:桌面重启 / SW 冷启后服务端没有该会话,`history` 会从**新造的空引擎**返回空历史 → 面板丢上下文。改为先 resume 再取历史
  2. `updateConversationOrigin` 原来是纯 `UPDATE`:会话创建发生在首条消息落库**之前**,此时行还不存在,UPDATE 空转 → 之后由持久化 INSERT 出来的行没有 origin,导致扩展会话**既出现在桌面列表、又不在面板列表**。改为 upsert(顺带补静态断言测试)

### M1.6 面板视觉对齐主对话 + 授权/问答回流 ✅ 2026-09-15

**背景**:用户验收 M1 时说「我发现你又搞了一套 UI,我要和主对话保持一致的 UI」。M1.1 只做到了**消息模型与协议**一致,视觉是另一套(自造气泡、文字图标、系统字体)。裁定:保留 Shadow Root + 手工对齐(**不**引入 antd / `components/chat/*`,**不**改成 iframe),能力面 = 只读消息流 + 输入框 + 授权按钮。

- [x] **对齐方式(为什么是"手工抄值")**:桌面聊天**没有可复用的样式表** —— 它的外观是 antd `ConfigProvider` 的 `algorithm`/`fontFamily` 两个 token + `components/chat/*` 里成百上千条内联样式。因此对齐 = 把每条视觉事实逐字抄进 `ui/styles.css`,**一条规则一个自定义属性、注释里写上它在 renderer 里的出处**(如 `--pm-user-bg: #f0f2f4` ← MessageGroup 用户气泡、`--pm-inset: 16px`、6px 滚动条 ← `renderer/index.html`)。`ui/MessageBlocks.tsx` 逐组件对应 `MessageGroup` / `SegmentView` / `CommandCard` / `ErrorDisplay` / `StreamingCursor`。
- [x] **Markdown 不复制、直接注入同一份主题**:`content/index.tsx` 把 `@ant-design/x-markdown/themes/light.css` 以 **`text` loader 内联**注进同一个 Shadow Root —— 与桌面吃的是同一个文件,主题包升级时自动同步。**顺序是承重的**:主题先、`ui/styles.css` 后,这样面板的修正能赢平局;唯一必须赢的一条是 `table { overflow: hidden }`(主题给的是对的,桌面对话列 1000px 宽;面板只有 380px,宽表格必须横滚)。
- [x] **明暗主题策略**:面板**只做浅色**,与主对话一致 —— 桌面的消息列本身就硬编码 `.x-markdown-light` + `#f0f2f4` 气泡,不跟随 `settings.theme`,所以镜像浅色才是忠实的,也不需要新增主题协议。
- [x] **红线:content script 不 import antd / `@ant-design/icons`** —— cssinjs 会把样式注进**页面的** `document.head`。`ui/icons.tsx` 因此内联逐字抄的 antd 图标 `d` 数据(24 个),`Icon` 组件按 `currentColor` 渲染 + `pm-spin` 动画。
- [x] **授权 / 问答回流(消除"死按钮")**:面板的授权按钮不是面板私有概念 —— 新协议 `session.setApprovalMode` 写的就是桌面端那颗按钮写的 `conversations.approval_mode`(`session-manager.refreshSandboxContext` 每条消息重读该列,所以**引擎侧零改动**);`panel/approval-response` / `panel/answer` 是**单向通知** `approval.response` / `ask_user.response`,靠 `callId === toolUseId` 与服务端既有的 park-and-timeout 对上(`hosted/prompts.ts`,审批 120s / ask_user 300s)。会话还不存在时先选档也成立:选择按 tab 存 `chrome.storage.session`,`ensureSession` 建好会话后回放(`applyTabApprovalMode`)。
- [x] **只读消息流**:操作行固定走桌面的 `viewOnly` 语义(复制 / 下载 + 耗时 / 上行 / 下行 / 缓存命中),不做点赞收藏 —— 那两者要回写消息元数据,面板会话没有可写的行。
- **验收结果**(新增 7 用例,全量 **439 绿 / 47 文件**):`tests/extension-markdown.test.ts` 9(原标题层级断言 `<h3>` 随渲染器改真实层级而更新,新增嵌套列表 / 表格对齐 / `<hr>`)、`tests/extension-panel-bridge.test.ts` 14(补 `FakeClient.notify`,新增 `panel/set-approval` 会话前后两条路径 + 回放 + 桌面值优先 + 两条单向通知 + 断线拒绝)。扩展 tsc **0 错**;node/web tsc 与 HEAD 基线逐条一致;`npm run build` + `npm run build:extension` 通过
- **真机验收(`scripts/probe-panel-render.mjs`,当时 23/23,现 29/29——后续补了 M2.7 的两项边距断言)**:面板的**外观**同样够不着 vitest(无布局引擎、无 Shadow-DOM 层叠),也不能靠读源码确认。脚本把**生产组件**(不是副本)+ 同序的两个 `<style>` 挂进 Shadow Root,渲染 4 个 fixture(主对话 / 等待批准 / ask_user / 出错+空态),用计算样式断言:主题在 Shadow Root 内生效(h1 24px/600)、应用字体族到位、气泡 `#f0f2f4`/圆角 12/右对齐、输入卡圆角 20 + `rgba(80,100,200,.2)` 阴影、工具头 `#f5f5f5` 与待批准 `#fff7e6`+`#ffd591`、宽表格**真的能横滚**(不是只有 `overflow-x:auto`)、代码块横滚、面板自身 0 横滚条、字块不越界、全 SVG 无 `<img>`、操作行是 viewOnly 形态、深色 CommandCard `#1e1e1e` + 跳过/运行按钮、ask_user 四选项 chip + 自定义输入、错误卡与空态、断线时输入框禁用,以及"没有一段文字与背景同色"(真机发现:深色卡片的 `color` 是继承的,必须逐叶子节点量)。截图落在 `$(os.tmpdir())/pm-panel-shots/` 供人眼与主对话并排看
- **与桌面端的有意差异**(两条,都记在 `ui/Transcript.tsx` 头部):① 不做执行段分组 —— 桌面把一次执行的 tool_use→tool_result 折成一个可折叠段(`ExecutionSegment`),面板按消息顺序平铺工具卡,内容相同、少一层折叠;② 工具卡默认折叠规则与桌面一致(`useState(block.name !== 'ask_user')`),因此**授权按钮也在展开后才露出** —— 这是照抄桌面行为,不是漏渲染

### M2 页面工具(看 / 点 / 填)—— 价值拐点 ✅ 2026-09-15

- [x] **M2.1 DOM 管线移植**:`content/page-tree.ts`(扁平树 + `[n]`/`*[n]` 编号 + `selectorMap: Map<number, Element>`,无 xpath;属性白名单 + 去重 + 20 字符截断;`MAX_NODES = 4000` 并**显式报截断**)+ `content/page-js.ts`(函数体三形态归一、结果序列化、CDP 表达式构造);`viewportExpansion` 的确切语义见下方「真机发现 3」
- [x] **M2.2 `page_*` 工具定义 + tier/路由改造**:`shared/agent-protocol/page-tools.ts` 作单一事实源(8 个工具名 + 只读集 + 会话白名单),被工具定义 / tier 判定 / `DEFAULT_ENABLED_TOOLS` / 会话白名单 / 插件分发共 **5 处**引用;新增 `engine/tool-tiers.ts`(`pageToolTier` / `tierOfTool`);三处路由点全部补齐——`dispatchToolExecution` 按 tier 分流(页面只读进并行读阶段、页面写逐个串行且过 `requiresApproval`)、`approveTool` **新增 `isPageTool` 分支**(否则会掉进 shell 兜底被当命令执行)、`handleToolUseResponse` 的 held 集合纳入 `pageHeldTools`。**页面工具刻意不进 `READ_TIER_TOOLS`/`WRITE_TIER_TOOLS`**——那两个集合选的是*执行器*不是*审批档*
- [x] **M2.3 执行链路**:桌面侧 `ToolExecutor.execPageTool` / `execPageReadTools` 走 `hostedToolCall`;插件侧 `content/page-tools.ts`(8 个执行器 + 点击全指针/鼠标序列 + 原生 setter 写值)+ `background/tool-router.ts`(三种失败态各自结算,不靠超时)+ `background/cdp.ts`(**CSP `unsafe-eval` 回退**:content script 求值被拒 → `chrome.debugger` + `Runtime.evaluate` 在主世界重试;判定按 tab 缓存、导航即失效)
- [x] **M2.4 在线门控**:`agentClientRegistry.isHostedCapable(sessionId)` 由 `session-manager` 在 `ask`/`refreshOptions` 写入 `engine.opts.hostedAvailable`,`tool-collection` 据此过滤 `category === 'page'` → 扩展离线时模型连工具定义都看不到
- [x] **M2.5 扩展会话白名单**:`session.create` 对 hosted 客户端注入 `allowedTools = page_* + ask_user`(恢复路径同样注入),模型在扩展会话里看不到 `browser`/`exec`/`write`
- **验收结果**(新增 43 用例,全量 **433 绿 / 47 文件**):`tests/extension-page-tree.test.ts`(24)、`tests/extension-tool-router.test.ts`(9)、`tests/extension-page-tools-routing.test.ts`(10);扩展 tsc **0 错**,web 23 / node 28 与 HEAD 基线逐条一致;`npm run build` + `npm run build:extension` 通过。桌面侧路由用例做过**变异验证**:删掉 `approveTool` 的页面分支、删掉在线门控各产生预期失败,恢复后全绿
- **真机验收(真实 Chromium,`scripts/probe-page-pipeline.mjs`,23/23)**:jsdom 既无布局引擎也没实现 `elementFromPoint`,因此可见性 / 遮挡 / 视口 / 滚动这些几何判定**在单测里全部被短路**——脚本把同一份源码打进真浏览器跑 fixture,覆盖:面板自身 DOM 不被读、被 fixed 浮层遮挡的按钮不编号、可点按钮编号、`display:none`/`aria-hidden` 子树跳过、**shadow DOM 穿透且可编号**、滚动容器带 `data-scrollable`、视口内外编号差异、`page_click` 真触发点击、`page_input` 原生 setter + `input`/`change`、`page_select` 按可见文本匹配、失效索引大声失败、内层容器滚动、滚动后索引仍可复用、窗口滚动、`page_execute_js` 参数绑定、超限页面被截断且带告警。脚本**刻意不加载插件**(同 clientId 的第二个客户端会把用户当前连接踢掉),只直接驱动 content script 这一半
- **过程中发现并修掉的三个真实缺陷**(前两个是移植自 Anywhere 的,第三个是移植后暴露的设计缺口):
  1. **零高容器整棵剪枝 → 整页读成空**:`isVisible` 把「矩形无尺寸」当不可见并**连子树一起丢**;而 `<html>`/`<body>` 在所有子元素都绝对定位时会坍缩成高度 0(画布型 / 仪表盘型页面常见)→ `page_get_content` 只返回空的 `<root></root>`。改为把「级联隐藏」(own DOM / `aria-hidden` / `hidden` / `display:none` / `visibility:hidden`)与「自身无盒」拆成两个判定:前者剪枝,后者只决定**能否被编号**,无盒容器照样下钻。Anywhere 原版同样有此问题
  2. **shadow DOM 里的控件永远拿不到编号**:`document.elementFromPoint` 返回到 shadow **宿主**就停,而宿主是被测元素的*祖先*,`el.contains(top)` 不成立 → 所有 web component 内部控件都编不上号(连文本都会因 `isTop=false` 被吞掉)。`hitTest` 改为逐层下钻 `shadowRoot.elementFromPoint`(带深度上限),并在每一层都检查面板自身 DOM
  3. **视口裁剪的契约不清**:真机实测 5600px 页面,限视口读 3020 字符 vs 全页读 2750 字符——**限视口反而更贵**(编号从 40 降到 5,但正文照样全量返回,只是视口外的交互元素退化成普通元素行多印了标签)。裁定:**视口只约束编号(可操作集),正文始终全量返回**,这样"总结这个页面"一次读就能成型;提示语改为「视口外的元素不带编号——需要操作它们时先 `page_scroll` 再 `page_get_content` 取新索引」,把契约写进输出而不是留在实现里
- **另外修掉一个移植来的潜伏缺陷**:Anywhere 的 `page_execute_js` 用 `new AsyncFunction(body)` 造函数(**没有参数名**),`args` 只能靠 `arguments[0]` 拿到——文档里写的 `args.x` 写法实际是坏的。改为显式命名参数(CDP 路径同样改),并补了参数绑定的单测与真机检查
- **偏离/取舍记录**:① `chrome.debugger` 声明为**普通权限**而非按需申请——`chrome.permissions.request` 需要用户手势,而工具调用发生在 service worker 里给不出手势,「按需授权」在 MV3 下不可实现;`shouldUseDebugger()` 仍保证权限缺失时不静默失败,安装期的权限提示成本由裁定 5 一并接受。② own-DOM 识别用 `data-pulsemind-panel` 属性而非 id 前缀。③ `MAX_NODES` 约束的是**走过的节点总数**(不是交互元素数)并回报 `truncated`。④ 新增的 4 个几何用例用**桩 `offsetWidth` + 桩矩形**把 jsdom 的几何路径打开,这样两个真机缺陷在单测里也有回归(变异验证:分别还原两处修复 → 3 个 / 1 个用例失败)

### M2.6 缺陷修复:反向 RPC 绑定生命周期 ——「ask_user 点击无响应」 ✅ 2026-09-15

> 现场:面板里模型问完话,点选项没有任何反应 —— 卡片不动、循环不动、也没有报错。先做二分:用真浏览器把**生产 `App`** 挂在 `chrome.runtime` 桩上点 chip,`panel/answer{callId:'toolu_ask_1',response:'北京'}` 正确发出(数组式与逗号字符串式 `choices` 都验过),**内容脚本这一半是干净的** —— 断点在下游。于是顺着 `panel-bridge → ws-server → hostedPromptRouter → engine` 逐段读代码。

- [x] **根因(致命)**:**客户端绑定的生命周期错了**。`client-registry` 的注释写的是「绑定活过一次 `agent.ask` 往返」,`ws-server` 也确实在 ask 的 `.finally()` 里 `unbind`。但 `agentSessionManager.ask` 是**启动循环就返回**(`void startLoop(...)`,不 await 整轮);而引擎在 `awaiting_approval` / `awaiting_user_input` 时会把循环**停在那里并让 loop promise 落定**。于是绑定在"循环起跑后几毫秒"就被释放,而 `approval.request` / `ask_user.request` 要等模型回话(数秒后)才发出 → `routeAskUser` 查 `agentClientRegistry.get(sessionId)` 拿到 `undefined` 直接 return → `hostedPromptRouter.asks` 始终为空 → `handleAskUserResponse` 静默 no-op。用户看到一个"死按钮",日志里一行不响。
- [x] **同一条根因的连带损坏**:`hostedToolProxy.call` 同样从注册表取 transport,取不到就 `reject('当前会话没有连接的浏览器客户端,无法执行页面工具')` —— 也就是说 **M2 的页面工具在真实运行中从来没成功过**(证据见下),M3.1 / M3.2 的审批路由同理。
- [x] **修复(把生命周期挂到连接上)**:`ws-server` 改为**每条连接一个 transport**(`hello` 之前就建,所以 `clientId` 用 getter 透传,不能值拷贝 —— 否则永远是 `'unknown'`,hosted 判定恒假);`agent.ask` 只 `bind` 不再 `unbind`;连接断开时在 `drop()` 里统一释放 —— 新增 `agentClientRegistry.unbindTransport(transport)` 按 **transport 身份**反查,这样同 clientId 顶替旧连接时,晚到的拆除不会误删新连接的绑定。
- [x] **为什么此前没有暴露**:`tests/agent-protocol-ws.test.ts` 的 fake `ask` 会 `await askHandler(...)`,即"停在循环里" —— 现实里不存在这种时序,它恰好把缺陷遮住了。改为**延后触发 handler**(`setTimeout 0`)以复刻真实时序:`ask` RPC 先落定,反向流量后到。
- [x] **变异验证**:把 ask-scoped 的 `unbind` 放回去 → 该文件 **5 个用例失败**(页面工具转发、审批请求、ask_user 请求、超时结算、断连释放),恢复后 16/16 全绿。即这个缺陷现在**可被发现**。
- [x] **可诊断性**:`handleAskUserResponse` / `handleApprovalResponse` 在 callId 无对应 pending 时不再静默,打印 `[HostedPrompts] … for unknown callId`;面板 `usePanel` 的两条作答路径补上 `ok:false` 上报(与 `setApprovalMode` 一致),断线时不再表现成"点了没反应"。
- **验收结果**:全量 **440 绿 / 47 文件**(该文件 16,新增「断连释放绑定」1 例);扩展 tsc 0 错,node 28 与基线逐条一致(我方文件 0);`npm run build` + `npm run build:extension` 通过
- **真机验收(新增 `scripts/probe-panel-ask-user.mjs`,16/16)**:把真 `App` 挂在 `chrome.runtime` 桩上,**用真鼠标点击**(隐藏 / 被遮挡 / `pointer-events:none` 的 chip 会在这里失败,而不是让用户困惑),覆盖:数组与逗号字符串两种 `choices`、点 chip 只发一条且 `callId === toolUseId`、自定义输入回车、多选需点确认且合并多项、`待批准` 的页工具展开后 批准 / 跳过 各发一条 `panel/approval-response`。**不加载插件、不调模型**,不碰用户额度与连接
- **审计侧证据**:`~/.pulsemind/db/pulsemind.db` 的 `audit_log` 当天仍在写入(最后一条 05:35Z),但全表 `hosted-tool` / `hosted-approval` 作用域**一条都没有**。`hostedToolProxy` 只在拿到 transport 之后才写审计,`routeApprovals` 则在发请求**之前**就写 `requested` —— 所以"零记录"能确定的是:**反向 RPC 从未把一次请求送达客户端**(页面工具因此从未成功过一次,审批提示从未发出过一次);至于页面工具是否被调用过,这个表答不了(取不到 transport 的 `call` 直接 reject、不写审计)。修复后这两类记录应开始出现,可以作为线上核对点

**顺带发现、本次未修的缺口(是否排期由你定)**:
1. **扩展会话的正文从未落库**。持久化在**客户端**侧(`useConversationPersistence` / `useHostedAgentSession` 在交换落定后 `saveConversation`),而 `AgentServiceConversations` 只有读(`hydrate`/`listByOrigin`/`origin`)没有任何写入口,插件端也没有"保存"这一步 → 扩展会话的 `messages` 表恒为空(DB 里两个扩展会话各 0 条消息),`conversations` 行只有标题与 origin。后果是 M0.4 那句"桌面重启后 `session.create` 恢复对话"对扩展会话实际**恢复出空历史**。修法需要先定:由服务端在消息变更时落库(新增写入口 + 去抖),还是给协议补一个客户端保存调用

### M2.7 缺陷修复:气泡正文下方多出的 16px —— x-markdown 的两层样式只注入了主题 ✅ 2026-09-15

> 现场:用户发完消息后「气泡中的文字下方有个多余的 16px 的 margin」。用户给的就是数值,所以先按数值反查而不是靠眼看。

- [x] **根因**:x-markdown 把 Markdown 的样式分成**两层**,一层取值、一层归零。取值层是主题(`themes/light.css`,挂在 `.x-markdown-light`,由 `content/index.tsx` 注入),它给 `p { margin: 0 0 16px }`、`li { margin: 0 0 14px }`、表格 `24px`;**归零层是包自带的 `dist/x-markdown.css`,挂在组件根类 `.x-markdown`**,里面有 `p:last-child / ul:last-child / ol:last-child / li:last-child / pre:last-child / table:last-child { margin-bottom: 0 }`。桌面端的根是 `clsx('x-markdown', className)` —— **两个类都在**,所以归零层一直生效;面板的根是自渲染的 `pm-md x-markdown-light`,没有 `.x-markdown`,也从未 import 那份文件 → 归零层整层缺席,每个块的下边距都留在气泡里,用户气泡里看就是正文下方多 16px(气泡 padding-bottom 只有 8px,变成 24px)
- [x] **修复**:在 `ui/styles.css` 主题修正区按同一份清单补齐 last-child 归零(取值仍由主题的 `--margin-*` 决定,两边只差"有没有被清零")。**不**把 `dist/x-markdown.css` 整份注进来:它是按 `.x-markdown` 选择器写的,面板的根没有这个类,注了也不生效;而那层还带着 `pre { white-space: pre-wrap }`、`table { width: max-content }` 与调试面板样式,整层引入会顺手改掉代码块换行/表格宽度这些 M1.6 已经验收过的行为。first-child 的 margin-top 不补——主题给的上行本来就是 0
- [x] **回归**:`scripts/probe-panel-render.mjs` 增加两项断言——正文最后一块 `margin-bottom === 0px`、气泡底边到正文的距离 `=== 8px`(只剩气泡自己的 padding)。**变异验证**:删掉这条 CSS,两项分别报 `16px` / `24px below the text` 并失败,即用户的描述被客观复现(29/29 → 27/29)
- **验收结果**:探针 **29/29**;全量 440 绿 / 47 文件;扩展 tsc 0 错;`npm run build:extension` 通过

### M2.8 缺陷修复:输入内容后消息不再自动滚动 ✅ 2026-09-15

> 现场:用户「输入内容时消息要能自动滚动」。面板里跟随末尾的代码本来就在,所以先把"它在什么条件下失效"量出来,而不是直接改。

- [x] **根因**:"是不是到底了"这个判断**在内容长高之后现量**,而不是记在状态里。`Transcript` 的跟随副作用原来的写法是 `const nearBottom = scrollHeight - scrollTop - clientHeight < 80; if (!nearBottom) return; endRef.scrollIntoView(...)` —— 副作用在 DOM 提交后运行,`scrollHeight` 已经是**长高之后**的值,而 `scrollTop` 还停在原位:内容一长高,量出来的距离就自己越过了阈值,于是这一次不跟随;下一次再长,距离更大,**从此整个回合都不再跟随**。真机量到的正是这个形态:一次整条回复追加后落在末尾下方 691px,后续流式块分别 1020px / 1521px,距离只增不减。桌面端没这个毛病,是因为它的 `isNearBottomRef` **只由 `handleScroll`(真实 scroll 事件)写**,内容长高不会去动它(`ChatView.tsx`,`startBottomPin` 另用于切换会话后的落底)
- [x] **修复**:`ui/Transcript.tsx` 拆成两半,与桌面端同构 —— ① `onScroll` 处理器写 `followRef`(用户真的滚动才改变"跟不跟"),② 每次提交后 `useLayoutEffect` 贴底(`el.scrollTop = el.scrollHeight`),并且**在绘制前**完成,新内容不会先在旧位置闪一帧。阈值 `NEAR_BOTTOM_PX = 80` 提为具名常量(面板滚动区约 450px 高,是主对话 100px 规则的等比缩小)
- [x] **顺带修掉同一行的第二个毛病**:`scrollIntoView({ block: 'end' })` 停在**滚动端口边缘**,而 `.pm-transcript` 自带 `padding-bottom: 8px` —— 即使判对了要跟随,末尾也留在可视区下方 7px。改成直接写 `scrollTop` 后距离恒为 0;顺带把这次写入限制在元素自身,不去动任何祖先滚动容器。被删掉的 `endRef` 只是这个调用的落点
- [x] **回归**:新增 `scripts/probe-panel-scroll.mjs`(17 项断言)。它比 M2.7 的渲染探针更靠上游:挂的是**真 `App`**、两个样式表按 `content/index.tsx` 的同序注入,并且通过**真 `chrome.runtime.onMessage` 通道**喂 `panel/event`(`listen()` 注册的监听器被桩接住),滚动则用**真 `wheel`**。覆盖:一次整条回复追加 / 两个流式块(每块都远大于面板高度)、用户上滚后新内容**不被拽回**(且"到末尾的距离"不会在读者眼底下缩水)、回到底部后**恢复跟随**、收起再打开落在最新一条、发出消息后气泡真的在可视区内,以及面板自身的写入不滚**宿主页面**(测试页刻意 3000px 高)
- **同一根因的第二个症状(探针顺带量出)**:原实现下**收起再打开会停在最旧的一条**(挂载时 `scrollTop = 0`、内容又比面板高 → 距离远超阈值 → 不跟随),探针里表现为"离末尾 1521px";修复后落在最新一条。这个场景此前没人报,但它和"输入内容不跟随"是同一处判断的两种表现
- **变异验证**(两半各自承重,互不遮挡):
  - **变异 A**(把判断还原成"内容长高后现量"):4 项跟随类断言失败(691px / 1020px / 1521px,以及收起再打开 1521px),`13/17`
  - **变异 B**(去掉 `followRef` 判断,永远贴底):3 项"读者不被拽回"断言失败(400 → 0px,新内容气泡跑到可视区上方 -34px),`14/17`
  - 修复前的原实现跑同一套断言是 **11/17**(4 项跟随 + 2 项被 `block:'end'` 吃掉 7px)
- **验收结果**:探针 **17/17**;M2.7 渲染探针 **29/29**、M2.6 作答探针 **16/16** 无回归;全量 440 绿 / 47 文件;扩展 tsc 0 错;`npm run build:extension` 通过

### M3 审批与隐私

- [x] **M3.1 审批路由**:`awaiting_approval` → `approval.request`(callId=toolUseId)→ `approval.response` → `engineCall('approveTool'|'rejectTool')`;120s 超时=拒绝;断连立即结算 —— 实现在 `hosted/prompts.ts`,**M2.6 修好绑定生命周期后才真正可达**
- [x] **M3.2 问答与续跑**:`ask_user.request/response`、`iteration_limit.response`(`extendLoop`/`stopExecution`)—— 同上
- [ ] **M3.3 面板授权开关**:逐次确认 / 本会话信任本页(`auto`)/ 完全只读 —— 开关本体在 M1.6 已交付(`APPROVAL_LEVELS` = `SandboxApprovalMode` 的三档:`auto` / `outside-ask` / `always-ask`,写会话列、下一条消息生效);计划里写的「完全只读」不在这个枚举里,扩展会话本来就只有 `page_* + ask_user` 白名单,若确实要一档"只读模式"需要先定它跟白名单的关系
- [ ] **M3.4 隐私红线**:扩展会话默认关闭记忆提取;页面内容不入 `MEMORY.md`;敏感过滤钩子;审计写入
- **验收**:写操作在 `always-ask` 下必须经面板批准;拒绝后模型能改道;审计日志可查

### M4 第二入口与体验打磨

- [ ] **M4.1 侧边栏第二入口(可选)**:Chrome `sidePanel` + 同一份 `ui/App.tsx`;两处入口共享同一会话
- [ ] **M4.2 多标签与切换**:切标签提示、标签关闭解绑、会话归属可视化
- [ ] **M4.3 丰富事件降级**:`plan_update` 计划卡、`spawn_progress`、`usage` 角标、错误重试
- [ ] **M4.4 可选增强**:`page_screenshot` / `page_navigate` / 下载与上传路径处理
- **验收**:两处入口会话一致;切标签不串会话;计划/用量/子代理进度可读

### M4.5 面板模型切换(需求)✅ 2026-09-15

> 需求:用户「需要有模型切换功能」。查过桌面端的模型概念之后再定语义 —— 桌面端的模型**不是会话级**的:`settings.activeProfileId` 是全局的一项,`profiles[]` 每项自带 (provider, baseURL, model, maxTokens, contextLength, apiKey, headers);而授权恰好相反,是 `conversations.approval_mode` 的会话列。所以"面板的模型开关"必须是**和桌面端同一处设置**,不能新造一列。

- [x] **语义裁定:全局,写桌面端同一个字段**。面板的模型下拉写 `settings.activeProfileId`(桌面 `InputArea` 的模型下拉写的就是它),不新增 `conversations.model_profile_id`。理由:① M1.6 的规矩是"面板的授权不是面板本地概念",模型同理;② 新造一列等于凭空发明一个桌面端没有的"每会话模型",两处下拉的文案必然开始打架;③ 零 schema 迁移。**代价显式承担**:桌面端只在自己改了设置时才刷新(`useConversationEngine` 的 `optionsChanged`),所以**切换必须由服务端自己热更新** —— `setActiveProfile` 写完设置后遍历 `this.sessions` 逐个 `refreshOptions`,换掉 `model/adapter/pins`,下一条消息生效
- [x] **协议**:`methods.ts` 增 `model.list` / `model.setActive`;`payloads.ts` 增 `ModelOption`(id/name?/provider?/model,**不带 apiKey/headers/baseURL**)与 `ModelState { profiles, activeId }`;`session.list` 的结果**顺带带上 `model`**(`panel-bridge` 每次 `snapshot()` 本来就要调它,面板挂载零额外往返)。`modelLabel(option) = name || provider:model` 做成**共享函数**,两个客户端共用一处文案逻辑
- [x] **服务端**:`session-manager.modelState()`(窄投影,凭据不上 wire)与 `setActiveProfile(profileId)`(校验 → 写 `settings.activeProfileId` → 热更新所有活跃会话 → 返回写后状态);`ws-server` 三个分支:`session.list` 异步带上 model(**读 model 失败要吞掉**,盘点不该因为旁路信息而失败)、`model.list`、`model.setActive`(空/未知 id → `invalidParams`)
- [x] **插件**:`bridge.ts` 增 `panel/set-model` 请求与 `panel/model` 通知;`panel-bridge` 转发 `model.setActive` 后**广播** `panel/model` 给所有打开的面板 —— 全局开关不能让没点的那个标签继续显示旧模型;`snapshot()` 两个返回分支都带 `model`;`usePanel` 增 `model` 与 `setModel`(乐观回显 + 失败回退 + 报错,与 `setApprovalMode` 同构,再用服务端返回的权威状态覆盖)
- [x] **界面(手工对齐,仍是 Shadow Root)**:`Composer` 的 trailing 槽按桌面端顺序放**模型在发送按钮左边**;按钮就是 antd `size="small" type="text"` 的小按钮 + 下拉箭头,文案取当前 profile。两个下拉(授权 / 模型)共用一处 `useDropdown()`(开合 + 外部点击关闭),不再各写一份;`icons.tsx` 补 `DownOutlined`,并让需要它的图标带上自己的 `viewBox="64 64 896 896"`(outlined 一族的画布与 filled 不同)
- [x] **桌面端同步改用共享 `modelLabel`**:`InputArea` 的 `modelItems` 与按钮文案都调它 —— 原来是 `label: p.name || provider:model`、按钮却是 `p.name`(name 为空时显示占位"选择模型"),两处不一致且会与面板再次漂移。**唯一行为差异**:profile 的 name 为空时按钮显示 `provider:model` 而不是占位文案(一个 profile 都没有时仍用占位)
- [x] **顺带修掉一个一直存在的缺陷:面板的两个下拉在真实 Shadow Root 里点不动**。`mousedown` 里用 `e.target` 判断"点在不在自己家里",而面板渲染在 Shadow Root 内、监听器挂在 `document`(边界之外):跨边界时 `e.target` 被**重定向为宿主元素**,点自己的菜单项也被判成外部点击 → 菜单在 mousedown 阶段就关掉,`click` 永远落不到选项上。真机量到:授权下拉点「按需确认」后按钮文案纹丝不动(仍是 `全部允许`),模型下拉点了什么都不发;而 `e.target` 是宿主 `<div data-pulsemind-panel>`、`composedPath()[0]` 才是 `BUTTON.pm-model-item`。改用 `e.composedPath()`(穿透影子边界)后两个下拉都正常。**这条此前被探针漏掉**:渲染探针只点"展开按钮"再读菜单项,从没点过菜单项本身,所以一直是绿的
- [x] **顺带对齐早就偏离的按钮指标**(都可引用源码,一起改):授权按钮文案色 `rgba(0,0,0,0.45)` → `#666`(`InputArea` 给 Button 的 inline color,它同时压过 antd 的 `text-color-hover`,所以 hover 只换底色);图标与文案间距 4px → **8px**(antd Button 根是 `inline-flex; gap: iconGap`,`iconGap = token.marginXS = 8`);补上桌面端授权按钮本来就有的箭头(`fontSize:10 / color:#bbb / marginLeft:4`,叠加在 gap 之上 = 12px)。hover 底色仍 `colorFillTertiary`(`rgba(0,0,0,0.04)`),另补按下态 `colorFill`(`0.15`),均取自 `button/style/variant.js` 的 text 变体
- [x] **回归**:
  - vitest:`agent-protocol-ws.test.ts` 新增 M4.5 组 5 例(盘点带 model 且**不含** apiKey/baseURL、`model.list`、`model.setActive` 成功、空/未知 id 被拒且未落到 manager、model 读失败时 `session.list` 仍作答);`extension-panel-bridge.test.ts` 新增 3 例(转发 + 广播只发一条且 payload 是写后状态、被拒时 `ok:false` **不广播**、断连拒绝)。两个 fake 都按真实契约实现 `modelState`/`setActiveProfile`(共享一份"设置存储",写入后下次读得到新值)
  - `probe-panel-render.mjs` 29 → **40 项**:两个按钮同一套小按钮指标(24/7/4/12/#666)、gap 同为 8px、两个箭头各自的字号与颜色、按钮回显当前档位、菜单项文案(含无 name 时退回 `provider:model`)、**菜单整个落在 380px 面板内且朝上展开**、超长模型名在菜单项里截断而非撑破面板、选中后按钮与菜单项用同一个 label、**服务端没报模型时不画选择器**而页脚其余部件照旧
  - `probe-panel-ask-user.mjs` 16 → **25 项**:真鼠标点模型项 → 恰好一条 `panel/set-model` 且 `profileId` 正确、菜单关闭、文案立刻跟上;真鼠标点授权项 → 一条 `panel/set-approval`。后两项就是上面那个 Shadow Root 缺陷的守门人(修复前必失败)
- **变异验证**:把 `composedPath()` 还原成 `e.target`(缺陷原状)→ 模型项点击**一条消息都不发**、授权项点击后文案不变,两个探针共 6 项断言失败;改回后 25/25 + 40/40
- **验收结果**:渲染探针 **40/40**、作答探针 **25/25**、M2.8 滚动探针 **17/17** 无回归;全量 **448** 绿 / 47 文件;扩展 tsc 0 错;`npm run build:extension` 通过;改动文件的 eslint 干净(仓库里 `session-manager.ts` / `ws-server.ts` 各一条既存 unused-var 报错,已用 `git show HEAD` 复核为改前既有)
- **已知未做(不是漏,是没到)**:模型下拉**不标当前项**(桌面端的 `modelItems` 也没有 `selectable`/`selectedKeys`,按钮文案本身就是回显);面板仍不做附件与专家 @;模型切换没有"仅本会话"这一档(与桌面端一致 —— 桌面端也没有)

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
| 反向 RPC | 全在 `tests/agent-protocol-ws.test.ts`(起真服务 + Node `ws` mock 客户端):tool.call 往返与超时回注、孤儿结果丢弃、审批 / ask_user 往返、断连释放绑定。**fake 的 `ask` 必须像真的一样"启动即返回"**(反向流量在 RPC 落定之后才到),否则绑定生命周期这类缺陷会被遮住(见 M2.6 的变异验证) |
| DOM 管线 | `tests/extension-page-tree.test.ts`(移植 Anywhere fixture + 扩展:面板 DOM 排除 / 节点上限 / 点击序列 / 索引失效),jsdom 环境;**几何另跑真机脚本** `scripts/probe-page-pipeline.mjs`(见 M2 验收) |
| 页面工具插件侧 | `tests/extension-tool-router.test.ts`(按 tab 转发、未绑定会话拒绝、CSP 回退、导航重置判定)+ `tests/extension-page-tools-routing.test.ts`(tier 归类、路由点存在性、在线门控) |
| 事件归约 | 插件 `useSession` 纯函数化后单测:乱序/截断/重复事件的镜像正确性 |
| 面板外观(M1.6) | `scripts/probe-panel-render.mjs`:真 Chromium 里挂**生产** `Transcript`/`Composer` + 同序两个 `<style>` 进 Shadow Root,4 个 fixture 会话,断言计算样式/几何/对比度,并输出截图。面板外观够不着 vitest(无布局引擎、无 Shadow-DOM 层叠),也不该靠人读 CSS 确认 |
| 面板作答路径(M2.6) | `scripts/probe-panel-ask-user.mjs`:真 `App` + `chrome.runtime` 桩 + **真鼠标点击**,断言 ask_user 选项 / 自定义回答 / 多选确认 / 审批按钮发出的 `panel/answer`、`panel/approval-response` 与 `callId`。这条链路(vitest 起不了 Shadow Root,面板 bridge 用例又假定请求已成形)只有它能覆盖 |
| 面板跟随末尾(M2.8) | `scripts/probe-panel-scroll.mjs`:真 `App` + 同序两个 `<style>`,经**真 `chrome.runtime.onMessage` 通道**喂 `panel/event`、用**真 `wheel`** 滚动,断言"内容到来贴底 / 收起再打开落在最新一条 / 上滚不被拽回 / 回到底部恢复跟随 / 发出的消息在可视区内 / 不滚宿主页面"(17 项)。"是否到底"取决于**何时写入 scrollTop** —— 是布局事实,读源码得不到,jsdom 也量不出 |
| 面板模型切换(M4.5) | 协议与广播在 `tests/agent-protocol-ws.test.ts` + `tests/extension-panel-bridge.test.ts`(含"被拒时不广播""读 model 失败不影响盘点");**看得见的部分**在 `scripts/probe-panel-render.mjs`(按钮指标 / 菜单落在 380px 内 / 长名截断 / 无 model 时不画选择器,11 项);**点得动的部分**在 `scripts/probe-panel-ask-user.mjs`(真鼠标点菜单项 → 一条 `panel/set-model`,授权下拉同理,9 项)。最后两项是 Shadow Root 里"外部点击关闭"用 `e.target` 会失效的守门人 —— 见 M4.5 |
| 端到端(手工) | 真实 Chrome + 桌面端:开面板 → 对话 → 看页面 → 点/填 → 审批 → 断线重连 → 桌面端继续 |

---

## 6. 风险与备选

| 风险 | 影响 | 对策 |
|---|---|---|
| MV3 SW 30s 休眠 | 连接断、事件丢 | 服务端为权威状态,唤醒即 `hello`+恢复;alarms 保活;必要时 offscreen 持连 |
| 站点 CSP 阻断页面上下文求值 | `page_execute_js` 失效(面板本身不受影响,见 §3.6) | `chrome.debugger` 回退;**实测结论:只能声明为普通权限**(`permissions.request` 需用户手势,SW 内的工具调用给不出 → 「按需授权」在 MV3 下不可实现);权限缺失时明确报错,不静默失败 |
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
5. 在插件里复用桌面端 React 聊天组件:运行环境(扩展页 vs Electron 渲染进程)与依赖(stores/IPC)完全不同,**组件不可复用**。(注:2026-09-15 用户裁定后,此条**只**排除组件复用 —— 「保持一致」已升级为硬要求,由 M1.6 手工对齐 + 真机脚本验收;AGENTS.md「界面复用」已同步修正,不再把插件当新造 UI 的例外。)
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

## 9. 已裁定

### 2026-09-14

| # | 议题 | 结论 | 落到文档 |
|---|---|---|---|
| 1 | 首发界面形态 | **页面内浮层**(FAB + Shadow Root) | §0.5、§3.6、M1.2、D3 |
| 2 | 页面工具命名 | **`page_*`** | §3.4、D2/D8 |
| 3 | 扩展会话是否进桌面列表 | **不进**(桌面列表按 origin 排除) | §3.3、§3.7、M1.4、D4 |
| 4 | `page_execute_js` 默认 | **默认启用,归 exec 层**(`outside-ask` 起需审批) | §3.4.2、D8 |
| 5 | FAB 注入权限 | **常驻 `<all_urls>` content script** | §3.6 manifest、D5、§6 风险 |
| 6 | 代码起点 | **移植 Anywhere 资产**(DOM 管线/WS 客户端/state/tool-router/cdp),UI 与工具层重写 | §1.3、D9 |
| 7 | 桌面端未运行 | **M5 可选项**:注册 `pulsemind://` 一键唤起 | §3.2.3、M5.4 |

### 2026-09-15(M1 验收后,用户反馈)

| # | 议题 | 结论 | 落到文档 |
|---|---|---|---|
| 8 | 面板与主对话的一致性 | **保留 Shadow Root,视觉手工对齐** —— 不 import antd/`components/chat/*`,不改 iframe;视觉事实逐条抄进 `ui/styles.css` 并注明出处,Markdown 直接注入同一份 `.x-markdown-light` 主题,真机脚本验收 | M1.6、AGENTS.md「界面复用」、§5 |
| 9 | 面板能力面 | **只读消息流 + 输入框 + 授权按钮**;操作行走 `viewOnly` 语义(不做点赞/收藏) | M1.6 |
| 10 | 面板授权按钮的落点 | 写桌面同一列 `conversations.approval_mode`(新协议 `session.setApprovalMode`);审批/问答答案走既有 `approval.response`/`ask_user.response` 单向通知,**引擎侧零改动** | M1.6、§3.4 |

### 2026-09-15(M2 验收后,用户反馈「ask_user 点击无响应」)

| # | 议题 | 结论 | 落到文档 |
|---|---|---|---|
| 11 | 反向 RPC 的客户端绑定活多久 | **跟连接走,不跟单次 `agent.ask` 走** —— 引擎会 park 在 `awaiting_approval` / `awaiting_user_input` 并让 loop promise 落定,ask 先返回、提示后到,所以 ask-scoped 的 `unbind` 必然把提示路径整条掐死。每条连接一个 transport,断连时按 transport 身份统一释放 | M2.6、`client-registry` 头注释、AGENTS.md |
| 12 | 未匹配 callId 的作答 | **不静默**:服务端打印告警,面板把 `ok:false` 显示成错误 —— "点了没反应"必须能区分成"没连上 / 已超时 / 服务端没收下" | M2.6、AGENTS.md |

遗留待定(不阻塞 M0,实施到对应里程碑前再定):

1. 浮层默认位置与尺寸;FAB 是否允许用户拖动并记住位置(涉及 DOM 管线 skip 与 storage 结构)。
2. 浮层展开状态是否跨会话记忆(`chrome.storage.session` vs `local`)。
3. ~~面板内的授权开关形态~~ —— 已定(裁定 10):复用桌面端同三档 + 同落点。
4. **扩展会话正文的持久化(M2.6 发现,未修)**:目前只有客户端会写库(桌面 renderer),服务端 `AgentServiceConversations` 是只读的,插件端又没有保存步骤 → 扩展会话的 `messages` 恒空,M0.4 的"重启后恢复对话"对扩展会话恢复出空历史。需要先定由服务端落库还是补协议方法,再排期。
