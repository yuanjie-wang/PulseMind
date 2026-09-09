# PulseMind 0.3.5 重构 Plan —— Agent 服务化

> 目标:Agent 能力层从"渲染进程的库"演进为"主进程宿主的服务",聊天 UI 与浏览器扩展都成为协议客户端。
> 背景设计:参考本地 `../Anywhere` 项目(desktop 包 = Electron 主进程宿主服务的已验证实现;protocol.ts = 协议基线)。
> 执行方式:逐任务执行,每个任务完成后跑 `npm test` + `npx tsc -p tsconfig.web.json --noEmit` + `-p tsconfig.node.json --noEmit` 对基线(web≤25 / node≤19,随重构消除存量错误时只降不升),并在本文档勾选。

## 里程碑依赖图

```
M0 基线收尾 → M1 服务内核(引擎入主)→ M2 WS服务+常驻 → M3 托管工具+审批 → M4 扩展接入 → M5 实例模型+站点路由
                                    └→ M2.5 存储层线程化(独立)
M0 基线收尾 → M6 画布统一:MerDraw 移植为 UML 模式(独立支线,可与 M1–M5 并行)
```

---

## M0 基线收尾

- [x] **M0.1 提交测试基建**(当前未提交)
  - 范围:`vitest.config.ts`、`tests/**`、`src/renderer/src/utils/incremental-save.ts`、`useConversationPersistence` 接线、`package.json`(vitest + test 脚本)
  - 信息:`test: add vitest suite covering env placeholders, settings store, incremental persistence`
- [x] **M0.2 提交 AGENTS.md 修正**(编码规范 + 过时信息,当前未提交)
  - 信息:`docs(agents): add coding standards; refresh stale architecture facts`
- [x] **M0.3 处理未跟踪文件**:`.workbuddy/` 加入 `.gitignore`;`readme.pdf`、`智能办公场景对比_*.md` 询问用户后决定(默认保持 untracked)

## M1 服务内核:引擎出渲染层(最大阶段,可再细分执行)

核心设计:引入 **`AgentHost` 能力接口**——引擎不再直接调用 `window.electronAPI`,而是声明它需要的主机能力:

```ts
interface AgentHost {
  llmStream(req): AsyncIterable<StreamChunk>   // 替代 api-proxy IPC 流
  execTerminal(cmd, opts, onOutput): Promise<ExecResult>
  fs: FsOps                                     // read/write/edit/grep/glob
  mcp: McpBridge                                // list/call per server
  persist: PersistenceBridge                    // saveConversation / appendMessages / toolResults
  notify?: UiBridge                             // 桌面通知等
}
```

同一份引擎代码 + 渲染 Host(现行为,IPC 实现)= 迁移前;+ 主进程 Host(Node 直连)= 迁移后。**渲染层协议客户端化与引擎迁主分两步落地,中间态始终可发布。**

- [ ] **M1.1 协议包雏形** `src/shared/agent-protocol/`
  - JSON-RPC envelope、PROTOCOL_VERSION、方法面(以 anywhere `protocol.ts` 为基线;补 `plan_update`/`spawn_progress`/`experience`/`knowledge` 事件类型)
  - 验收:shared 包内类型自洽,两端可引用,附最小单测
- [ ] **M1.2 引擎拆分四职责 + AgentHost 接口化**
  - `AgentEngine.ts`(2391 行)拆为:`engine/loop.ts`(状态机编排)、`engine/stream.ts`(已有 adapters)、`engine/tool-loop.ts`(工具执行收口)、`engine/spawn.ts`(子代理)
  - **顺手吸收 worker 计划 P0**:工具入参 JSON 改增量解析(引擎入主后该计算在主进程,Web Worker 方案作废)
  - 迁移完成前保持渲染 Host 全绿(现有 29 测试 + 新增 host 接口 mock 测试)
- [ ] **M1.3 渲染 Host 实现核对**:现有 `window.electronAPI` 调用面全部归拢到 Host 实现内(纯搬运,不改行为)
- [ ] **M1.4 主进程 Host 实现 + 会话管理器**:main 内 `sessionManager`(convId→engine,现有 enginesRef 逻辑平移),LLM 直连 fetch(**api-proxy 对引擎退役**,api-proxy 本体保留给非引擎请求)
- [ ] **M1.5 渲染层协议客户端化**:`useConversationEngine` 重写为协议消费者(IPC 桥:ask/cancel/history + event 推送);ChatView/节流渲染不动
- [ ] **M1.6 回归与性能基线**:长任务对比重构前(流式 CPU、主进程保存停顿);渲染层 bundle 不再含引擎

## M2 WS 服务 + 托盘常驻

- [ ] **M2.1 WS 服务**:`127.0.0.1:PORT` + JSON-RPC 分发 + token 鉴权(token 落盘 `~/.pulsemind/service-token`)+ 双向心跳 + EADDRINUSE 退避随机端口(照抄 anywhere/desktop 模式)
- [ ] **M2.2 会话多客户端化**:conversation 表加 `origin`/`clientId`;同一 clientId 重复连接踢旧;全局并发上限 + FIFO 排队
- [ ] **M2.3 托盘常驻**:关窗驻留(mac 拦 close / win 隐藏)、托盘菜单(打开窗口/服务状态/退出)、开机自启设置(`app.setLoginItemSettings`)——同时服务定时任务需求
- [ ] **M2.4 服务设置页**:开关、端口、token 查看/重置、连接状态
- [ ] **M2.5 存储层线程化(独立可跳过)**:DB 迁入 utilityProcess/worker_threads,主进程经 RPC 访问,消除同步 SQLite 对主进程事件循环的阻塞

## M3 托管工具 + 审批链

- [ ] **M3.1 注册表 hosted 工具类别**:在线客户端声明能力集,`browser.*` 随扩展在线状态动态暴露/收缩
- [ ] **M3.2 反向 RPC**:`tool.call`→客户端执行→`tool.result` 回注;timeoutMs、孤儿结果丢弃、页面关闭回错误(Anywhere §7.4 规则)
- [ ] **M3.3 审批路由**:`approval.request`/`ask_user` 路由到会话来源客户端(扩展对话框 or 桌面 UI);超时视为拒绝;yolo/confirm 分级沿用实例配置
- [ ] **M3.4 browser.* 工具集**:从 anywhere extension 移植 DOM 管线(getBrowserState/click_by_index/input_text/scroll/execute_js;附录 A 的 WeakMap 定位方案)
- [ ] **验收**:扩展在线时 agent 能"看/点/填"任意页面;扩展离线时模型看不到 browser 工具

## M4 扩展接入

- [ ] **M4.1 协议兼容验证**:anywhere extension 改服务地址 + token 直连 PulseMind 跑通流式对话(预期只需配置改动)
- [ ] **M4.2 差异补齐**:PulseMind 专有事件(plan/experience)在扩展端的降级展示
- [ ] **M4.3 隐私红线**:页面上下文默认不进长期记忆;敏感过滤钩子
- [ ] **M4.4 (可选)PulseMind 品牌扩展构建**:复用 anywhere extension 代码,换 icon/默认地址

## M5 实例模型 + 站点路由 + Admin

- [ ] **M5.1 profile → AgentInstance**:补 persona 段、每实例 tools 启停/approval 模式、skills/mcp 启用集(现全局启用状态平移为默认实例)
- [ ] **M5.2 SiteRule**:存储 + domain/glob 匹配 + priority 排序;`agent.ask` 携带 pageContext.url 命中路由;未命中走默认实例
- [ ] **M5.3 Admin 能力进设置页**:实例编辑、站点规则管理、会话审计(哪实例/何时/调了什么)
- [ ] **M5.4 用量核算**:token 按 agentId/站点聚合(现有 token_usage 表扩展)

## M6 画布统一:MerDraw 移植为 UML 模式(独立支线)

> 源项目:`../MerDraw`(React 18 + Vite + @xyflow/react v12 + dagre + mermaid v11,自包含无后端)。
> 方案要点:统一入口 = 画布视图顶部「自由画布 | UML 绘制」**平级模式切换**(两种交互模型根本冲突,不做混合画布);两模式共享入口/AI 链路/主题/导出;远期只做单向引用(UML 导出 png 贴画布卡片),不做双向嵌套。

- [ ] **M6.1 依赖 + 代码平移**
  - 新增 `@xyflow/react@12`、`@dagrejs/dagre`;`html-to-image` 随 MerDraw 引入(仅 UML 导出用,自由画布导出走隐藏窗口截屏,见 M6.7 注)
  - **mermaid 不新增**:x 已带 11.14(静态引入,已在主 chunk);把 `mermaid@^11.12.1` 提升为 package.json 直接依赖(npm dedupe 同一份)——转换管线深度绑定 v11 AST 细节,不能隐式挂在 x 的版本上
  - MerDraw `src/` 整体迁入 `src/renderer/src/uml/`(types/conversion/utils/nodes/components/hooks),import 路径修复;样式挂 `.merdraw-root` 容器隔离,防与 antd reset 互相污染
- [ ] **M6.2 统一入口 + 模式切换**:画布视图顶部切换器,记住上次模式;ZoomControls 等壳层按模式切换
- [ ] **M6.3 持久化**:新表 `uml_diagrams(id, title, diagram_json, mermaid_text, updated_at)`——`diagram_json`(DMDiagram 完整内部模型)为编辑态事实源,`mermaid_text` 供 Agent 消费与对外交换;多 tab(TabsBar)映射多行,切模式恢复上次 tab 集;不并入自由画布 manifest(数据模型正交)
- [ ] **M6.4 主题适配**:light 首发映射 antd token;dark 主题单独任务(MerDraw 本身只有浅色)
- [ ] **M6.5 测试移植**:`utils/sequence.ts`(层叠数学)/`layout.ts`/`routing.ts` 无 DOM,直接进 vitest;`conversion/`(mermaid AST 有"仅浏览器可跑"已知限制)尝试 vitest jsdom 环境,不可行则记为已知缺口
- [ ] **M6.6 Agent 集成(价值最高)**:新增 `uml_render`/`uml_read` 工具(与 canvasEngine 的 rect 生成对称)——用户说"画个订单系统类图"→ agent 产 mermaid → 渲染成**可继续手编的图**;用户拖拽后 `uml_read` 让 agent 读最新结构继续迭代;UML 模块暴露全局可寻址 store 命令入口(zustand,与 canvasStore 同模式);M1 服务化时随工具表自动随迁
- [ ] **M6.7 (可选)跨模式引用**:UML 导出 png 贴为自由画布 annotation 卡片,双击进 UML 编辑;导出机制两个候选——html-to-image(实时 DOM,MerDraw 现成)或复用 `captureCanvasImage` 隐藏窗口(mermaid 文本→HTML→PNG,复用度最高),实现时对比定夺
- [ ] **M6.8 (可选,独立小任务)主包瘦身**:`CodeBlock` 的 Mermaid 渲染改 `React.lazy` 动态加载,把 mermaid 从 2.8MB 主 chunk 挪到懒加载 chunk(代码块含 mermaid 的场景少,功能无损)



## 附:原"渲染线程 Worker 化"分析的处置(被本 Plan 吸收)

| 原条目 | 处置 |
|---|---|
| P0 工具入参增量 JSON.parse | M1.2(引擎入主后计算移主进程,无需 Web Worker) |
| P1 大文件内容过境渲染层 | M1.4 顺带消除(工具执行在主进程,内容不再过境) |
| P2 全量序列化 | 弱化:引擎入主后序列化在主进程;beforeunload 同步保存随 M1.5 重估 |
| P3 tokenizer 预留 | 引擎 Host 接口留 estimator 可替换缝,M 阶段不排期 |
| XMarkdown 增量渲染 | 不属线程问题,列入重构后 UI 优化待排期 |

## 执行约定

1. 每任务一分支提交(沿用 `feat/fix/perf(scope):` 规范),按任务勾选本文档随提交更新
2. 破坏性协议变更递增 PROTOCOL_VERSION 并在握手层拒绝旧客户端
3. M1 期间保持"中间态可发布":每个任务结束应用可正常聊天
