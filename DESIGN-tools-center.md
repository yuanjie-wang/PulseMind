# DESIGN —— 工具中心改版:预置工具化 + 列表/工作区双态布局

> 2026-09-12 需求(对 PLAN-0.4.0 M5 的修订,以下称 M5R):
> 1. 去掉工具中心重复的标题栏(全局 Header 的「能力 • 知识 • 工具」切换器已经是页面标题);
> 2. 去掉「预制模板」概念——预置的就是**工具**:可直接使用,也可二次编辑,不是只读克隆源;
> 3. 进入工具中心 = 左侧工具列表 + 右侧工具区(运行视图);
> 4. 进入编辑/创建态 = 工作区:左侧实时预览 + 右侧对话区,多轮对话驱动生成与迭代。

> 已定决策(2026-09-13 确认,不再重开):
> - D-R1 任何工具(含预置)提供**「复制」**操作生成副本——想改预置又想留出厂版,复制一份改副本;
> - D-R2 预置工具**允许删除**,与普通工具同权;删除记入 `.presets.deleted.json` 防升级复活;
> - D-R3 预置工具**本期不做版本升级**(应用更新不覆盖已落盘预置,用户编辑优先);
> - D-R4 **本期不做工具改名**(名称沿用首次需求前 20 字)。

---

## 一、现状与问题

| 现状 | 问题 |
|------|------|
| `ToolCenter.tsx` 页内渲染 18px 粗体标题 `viewTitle.tools` + 「创造工具」按钮 | AppLayout Header 已有centers 切换器兼作页标题(AppLayout.tsx:175-195),页内标题重复 |
| 模板存放于 `~/.pulsemind/tools/templates/<id>/`,以 `isTemplate` 伪工具只读呈现,使用 = `toolCloneTemplate` 克隆副本 | 「模板→克隆→改名→再编辑」链路重;克隆副本与原件割裂,预置件不能就地演进 |
| 画廊为卡片网格 + 「我的工具 / 预置模板」两个 Tabs | 入口层级深;Tabs 与 Header 切换器风格不统一 |
| `ToolStudio.tsx` 全屏接管,左对话(380px)/右预览 | 与目标布局(左预览/右对话)相反;离开工作室即丢失对话上下文(generator 是组件 ref,重新进入后引擎无历史) |
| `generator.ts` 每轮结束 `saveConversation('toolstudio_<id>')` | `deriveConvType` 对 `toolstudio_` 前缀返回 `'normal'` → **工作室会话泄漏进聊天会话列表**(现网 bug,顺手修) |
| 选择态(哪个工具打开、是否在编辑)存在 `ToolCenter` 局部 `Pane` state | 切到能力/知识再切回来,状态归零;无法深链 |

## 二、三态模型(总览)

工具中心是一个视图(`view.kind === 'tools'`)下的三个状态,全部由导航参数驱动:

```
                 ┌─────────────────────────────────────────────┐
                 │  浏览态(默认) { kind:'tools' }               │
                 │  ┌────────┬────────────────────────────┐    │
                 │  │ 工具列表 │  工具区 ToolRunner          │    │
   选中工具 ──── │  │        │  (iframe 运行 + 操作条)      │    │
   点击「编辑」───│  │        │                            │    │
                 │  └────────┴────────────────────────────┘    │
                 └─────────────────────────────────────────────┘
                        │ 点击「编辑」/「新建工具」          ↑ 点返回
                        ▼                                  │
                 ┌─────────────────────────────────────────────┐
                 │  工作室态 { kind:'tools', toolId?,           │
                 │            toolEditing: true }              │
                 │  ┌────────────────────────┬───────────┐     │
                 │  │ 实时预览(左)             │ 对话区(右) │     │
                 │  │ iframe + bridge         │ 多轮对话    │     │
                 │  └────────────────────────┴───────────┘     │
                 └─────────────────────────────────────────────┘
```

| 态 | 导航参数 | 左侧 | 右侧 |
|----|---------|------|------|
| 浏览态 | `{ kind:'tools' }` | 工具列表 | 空态引导 |
| 运行态 | `{ kind:'tools', toolId }` | 工具列表 | ToolRunner |
| 工作室态 | `{ kind:'tools', toolId?, toolEditing:true }`(无 `toolId` = 创建) | 实时预览 | 对话区 |

选择态进导航后,切到能力中心再切回,工具与状态保持;深链(如 Agent 建议入口)依旧可用。

---

## 三、预置工具(替代预制模板)

### 3.1 语义

- 预置工具 = **随应用分发的普通工具**,落盘在用户工具目录,与用户创建的工具同权:直接运行、就地二次编辑(Agent 直接改它的 `app.html`)、复制、导出、删除。
- 唯一差别:`tool.json` 带 `preset: true` + `presetId`(对应分发件 id),UI 上分组展示并打「预置」标。
- **应用升级不覆盖**已落盘的预置工具(用户编辑优先,决策 D-R3);删除过的预置不因升级复活;提供「恢复预置工具」兜底。
- 想改预置又怕改坏 → 先「复制」出副本再改副本,出厂原件保留(决策 D-R1)。

### 3.2 数据模型(`src/shared/types/user-tool.ts`)

```ts
export interface UserTool {
  // ...现有字段不变
  /** 随应用分发的预置工具;与普通工具同权,可编辑可删除。 */
  preset?: boolean
  /** 分发件 id(preset 工具专属,用于恢复重播)。 */
  presetId?: string
  // 删除: sourceTemplateId(ToolCreateInput 同步删)
}
```

### 3.3 目录布局

```
templates/pulsemind/tools/
  presets/                       # 分发件(bundle 内,改名自 tools/templates/)
    calculator/tool.json + app.html
    pomodoro/...

~/.pulsemind/tools/
  preset_calculator/             # 预置工具(真实工具目录,id = 'preset_' + presetId)
  tool_ab12cd34/                 # 用户工具(id 规则不变,天然不冲突)
  .presets.deleted.json          # 已删除预置 id 列表(点前缀,list() 自动跳过)
```

- 清单由播种器在落盘时**改写盖章**:读分发件 manifest → 写 `id: "preset_<id>"`、`preset: true`、`presetId: "<id>"`(分发件自身 manifest 不需要改)。
- `copyTemplatesToDataDir` 的通用递归拷贝**排除 `tools/presets`**(播种器接管,避免产生一份裸拷贝死重)。

### 3.4 播种 / 迁移 / 恢复(`src/main/storage/tool-store.ts`)

决策逻辑抽为纯函数放 `src/shared/preset-seeding.ts`(可进 vitest,符合仓库纯逻辑测试约定):

```ts
/** 返回本次需要播种的 presetId 列表:已存在的不动,已删除的不复活。 */
export function planPresetSeeds(bundleIds: string[], existingIds: string[], deletedIds: string[]): string[]
```

`toolStore` 新增/调整:

| 成员 | 行为 |
|------|------|
| `seedPresets(bundleDir)` | 启动时调用(main 初始化,`ensureDataDir` 之后):`planPresetSeeds` → 逐个盖章落盘;幂等 |
| `migrateLegacyTemplates()` | 旧装升级:若 `~/.pulsemind/tools/templates/` 存在,把每个 `<id>/` 按 `seedPresets` 同规则晋升为 `preset_<id>`,全部成功后 `rmSync` 旧目录;失败保留、下次重试 |
| `list()` | 不变——预置工具自然出现在列表,按 `updatedAt` 排序 |
| `remove(id)` | 追加:若 `preset` 工具,把 id 记入 `.presets.deleted.json`(允许删除,D-R2) |
| `getDeletedPresets() / restorePresets(bundleDir)` | 恢复 = 清空删除记录 + 重跑播种,返回新增工具 |
| `duplicate(id)` **(新)** | 复制出独立副本:新 `tool_<uuid>` 目录,拷 manifest(改 id、名称加「副本」、**剥掉 `preset`/`presetId`**——副本是普通工具)+ `app.html`;**不拷 `storage.json`**(KV 从空白开始,避免运行数据混串) |

分发件 manifest 里的旧 `sourceTemplateId` 字段(若有)在盖章时丢弃。

### 3.5 IPC 变更(`tool.handler.ts` / `ipc-channels.ts` / preload / `electron.d.ts`)

| 操作 | 通道 | 说明 |
|------|------|------|
| **删除** | `TOOL_LIST_TEMPLATES` / `TOOL_CLONE_TEMPLATE` / `TOOL_READ_TEMPLATE_HTML` | 连同 preload 的 `toolListTemplates / toolCloneTemplate / toolReadTemplateHtml` 一并移除 |
| 新增 | `TOOL_DELETED_PRESETS → string[]` | UI 决定是否显示「恢复预置工具」 |
| 新增 | `TOOL_RESTORE_PRESETS → UserTool[]` | 清删除记录 + 重播种,返回新增 |
| 新增 | `TOOL_DUPLICATE (id) → UserTool` | 复制副本(D-R1),语义见 `toolStore.duplicate` |

`TOOL_CREATE` 的 `sourceTemplateId` 入参删除(创建只走工作室)。

### 3.6 删除工具时的会话清理(顺手修)

`toolStore.remove(id)` 目前只删目录,`toolstudio_<id>` 会话与消息永久残留。设计:删除工具时 best-effort 调 `deleteConversation('toolstudio_<id>')`(handler 层做,store 不依赖 db 模块)。

### 3.7 聊天列表泄漏修复(顺手修)

`conversation.db.ts` `deriveConvType`:

```ts
if (id.startsWith('toolstudio_')) return 'tool'   // 新增,'tool' 不在 listConversations 的 type='normal' 过滤内
```

加一次性迁移:`UPDATE conversations SET type='tool' WHERE id LIKE 'toolstudio_%'`(upsert 的 ON CONFLICT 不更新 type,旧行必须显式迁移)。

---

## 四、布局与组件设计

### 4.1 组件划分

```
ToolCenter.tsx        两态外壳:读 navigationStore,渲染 ToolListPage 或 ToolWorkspace;不再持有任何业务 state
ToolListPage.tsx      浏览/运行态:左 ToolList + 右 ToolRunner(或空态)
ToolList.tsx          分组列表(预置工具 / 我的工具)+「+ 新建工具」入口 + 行内操作(编辑/导出/删除)+ 恢复预置入口
ToolRunner.tsx        工具区:瘦头部(名称+描述+刷新/导出/在工作区编辑)+ iframe;不再有返回按钮(返回=列表语义)
ToolWorkspace.tsx     工作室态:左 LivePreview + 右 Conversation(由 ToolStudio.tsx 改造重命名,内部逻辑保留)
```

拆分后单文件职责单一,符合「方法 ≤200 行 / 类 ≤1000 行」约束;`bridge-host` / `generator` 不动结构。

### 4.2 浏览/运行态布局

```
┌──────────────┬────────────────────────────────────────────┐
│ [+ 新建工具]   │  计算器  简洁的计算器,支持键盘输入…            │
│              │                 [刷新] [导出] [在工作区编辑]   │
│ 预置工具       │────────────────────────────────────────────│
│  ▸ 计算器     │                                            │
│  ▸ 番茄钟     │                                            │
│  ▸ Post 工具  │           ToolRunner iframe                 │
│ 我的工具       │        (sandbox + capability bridge)        │
│  ▸ 我的调试器  │                                            │
│              │                                            │
│ 恢复预置工具 ← 仅在有删除记录时显示                              │
└──────────────┴────────────────────────────────────────────┘
```

- 列表宽 ~240px;分组标题小字灰色;行 = 名称 + 描述单行省略 + 「预置」小标;hover 浮出行内操作(**复制** / 编辑→工作室态 / 导出 / 删除)。
- 点行 = `navigate({kind:'tools', toolId})`;右侧立即换工具。未选中(浏览态)右侧 = 空态:「创造你的第一个工具」CTA + 预置说明。
- Runner 里「在工作区编辑」= `navigate({kind:'tools', toolId, toolEditing:true})`。
- 预置工具行内同样有「编辑」——就地改分发副本,不再有「复制到我的工具」;想留原件就先点「复制」。

### 4.3 工作室态布局(左预览 / 右对话)

```
┌──────────────────────────────────────┬──────────────────┐
│ [←] 番茄钟               [刷新预览][停止] │  对话区            │
│──────────────────────────────────────│                  │
│                                      │ ▸ 用户:做一个番茄钟 │
│         Live Preview iframe          │ ▸ 状态: write app.html│
│    (srcDoc + injectToolSdk +         │ ▸ 助手:已生成,支持…  │
│     connectToolBridge)               │ ▸ 用户:加一个休息音效 │
│                                      │ ▸ 助手:(流式回复)   │
│   创建态尚未生成时 = 引导占位:           │                  │
│   「描述需求,工具会出现在这里」           │ [输入框][发送]      │
└──────────────────────────────────────┴──────────────────┘
```

- 对话列固定 ~400px;预览占其余宽度。
- 「←」返回运行态(`{kind:'tools', toolId}`;创建中无 toolId 则回 `{kind:'tools'}`)。
- 首次生成成功后:工具记录已建 → 用 `navigate` 补上 `toolId`,此时返回可落运行态。

### 4.4 对话区设计

**条目模型**(沿用现有 `ChatEntry` 思路,来源变为可推导):

```ts
type ConversationEntry =
  | { kind: 'user'; text: string }                       // 用户输入
  | { kind: 'assistant'; text: string; streaming?: boolean } // 助手文本块(取自 engine.messages 的 assistant text)
  | { kind: 'status'; text: string; done: boolean }      // 工具事件(read/write/edit…,现有 ToolEvent)
```

**多轮对话的持久与恢复**(本轮的核心补强):

1. **生成器实例模块级化**:`generator.ts` 新增模块级注册表 `Map<conversationId, ToolGeneratorHandle>`,工作室挂载时取用/创建、卸载只解绑监听**不销毁**。生成中进行中切走再切回,进度不丢(写盘走主进程 IPC,与组件生命周期无关)。
2. **历史恢复**:进入工作室时 `getConversation('toolstudio_<id>')` → `storedMessagesToAgentMessages` → 新增的 `handle.loadHistory(msgs)`(内部 `engine.loadConversation`)→ 对话区同时回放出历史条目。引擎带完整 tool_use/tool_result 历史,下一轮迭代天然有上下文。
3. **助手文本流式**:handle 新增 `onMessages(cb)`(引擎 notify 时回调全量消息列表);对话区从消息列表折叠出 user/assistant 条目,工具事件仍走现有 `onToolEvent`。去掉现在写死的「已生成。继续提修改要求…」占位文案,显示助手真实回复。
4. 会话 id 保持 `toolstudio_<toolId>`,标题=工具名;`type='tool'` 后只进工具会话存储,不再进聊天列表。

**输入交互**:保留 Enter 发送 / Shift+Enter 换行;未配 API Key 时输入区上方给出设置引导(现行为保留);生成中「停止」可取消(现行为保留)。

---

## 五、文件变更清单

| 层 | 文件 | 变更 |
|----|------|------|
| shared | `types/user-tool.ts` | +`preset`/`presetId`;−`sourceTemplateId`(含 `ToolCreateInput`) |
| shared | `preset-seeding.ts` **(新)** | `planPresetSeeds` 纯函数 |
| shared | `ipc-channels.ts` | −3 个模板通道;+`TOOL_DELETED_PRESETS`/`TOOL_RESTORE_PRESETS` |
| main | `storage/tool-store.ts` | 播种/迁移/删除记录/恢复/**duplicate**;−模板读取三方法 |
| main | `storage/index.ts` | 通用拷贝排除 `tools/presets`;启动衔接播种 |
| main | `storage/conversation.db.ts` | `deriveConvType` + `toolstudio_`→`'tool'`;启动迁移 UPDATE |
| main | `ipc/tool.handler.ts` | 通道增删;删除工具时级联 `deleteConversation` |
| preload | `index.ts` | API 面同步(−3 +2) |
| renderer | `types/electron.d.ts` | 同步 |
| renderer | `navigation/types.ts` | `AppView` +`toolEditing?: boolean`(`toolId` 注释更新) |
| renderer | `components/tool-studio/ToolCenter.tsx` | 重写为两态外壳 |
| renderer | `components/tool-studio/ToolListPage.tsx` **(新)** | 左列表+右工具区 |
| renderer | `components/tool-studio/ToolList.tsx` **(新)** | 分组列表/行内操作/恢复入口 |
| renderer | `components/tool-studio/ToolRunner.tsx` | 瘦身为工具区(去返回按钮) |
| renderer | `components/tool-studio/ToolStudio.tsx` → `ToolWorkspace.tsx` | 布局对调;历史恢复;助手流式;导航化 |
| renderer | `tool-studio/generator.ts` | 实例注册表;`loadHistory`/`onMessages` |
| bundle | `templates/pulsemind/tools/templates/` → `presets/` | 目录改名,内容不动 |
| tests | `tests/preset-seeding.test.ts` **(新)** | 计划函数覆盖:存在跳过/删除不复活/新预置播种 |

i18n:沿用 ToolCenter 现状(页内中文直书),不新增 key;`viewTitle.tools` 保留(Header 切换器仍用 `menu.tools`,registry 的 `VIEW_TITLES` 不动)。

## 六、边界与异常

| 场景 | 行为 |
|------|------|
| 复制预置工具的副本 | 副本是普通工具(无 `preset` 标),落入「我的工具」分组;KV 从空白开始;原件不动 |
| 分发件缺失(企业裁剪) | 播种器静默跳过;列表只有用户工具,空态只剩「创造工具」 |
| 用户改了预置工具后升级应用 | 不覆盖(拷贝仅 Missing 时发生),用户版本即最终版本 |
| 删除预置后升级 | `.presets.deleted.json` 挡住复活;「恢复预置工具」可找回**当前分发版本**(编辑内容不可找回,与普通工具删除同语义,确认弹窗文案注明) |
| 生成中切走/切回 | 引擎在注册表中继续跑;切回重新订阅,进度与产物不丢 |
| 生成中删除该工具 | 先 cancel generator 再删(handler 级联);工作室若开着,返回列表 |
| `app.html` 被手动删 | Runner/预览显示「该工具还没有内容」占位(沿用) |
| 旧数据(已有 toolstudio 会话在聊天列表) | 启动迁移 UPDATE 后从聊天列表消失,工作室仍能读回 |

## 七、非目标(本期不做)

- 工具重命名 UI、图标自定义、缩略图缓存(原 M5.4 的卡片缩略图随网格一起废弃);
- 预置工具版本化升级(分发件带版本号做合并升级);
- 工作室对话在聊天搜索中的可搜性;
- 生成器注册表的 LRU/内存上限(实例量级 = 工具数,暂不设限)。

## 八、实施顺序与验收

1. **数据层**:types + preset-seeding 纯函数 + tool-store 播种/迁移/删除记录 + conversation.db 两处小修 + bundle 目录改名 → 单测 `npm test`;手工验证:旧数据启动晋升、新装播种、聊天列表无 toolstudio 泄漏。
2. **IPC/preload**:通道增删 + 复制 + 删除级联 → `npm run dev` 走通列表/复制/恢复。
3. **导航与列表布局**:AppView.toolEditing + ToolCenter/ToolListPage/ToolList/ToolRunner 瘦身 → 验收:三态切换、选中保持、无页内标题、预置分组与行内四操作(复制/编辑/导出/删除)。
4. **工作室改造**:generator 注册表/loadHistory/onMessages + ToolWorkspace 对调布局 → 验收:创建全流程、多轮迭代、切走切回上下文保持、预置工具就地编辑、复制副本后编辑互不影响。

最终验收 = 需求四条逐一走查 + `npm test` + `npm run lint`。
