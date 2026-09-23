// ── About page ──
// Formerly AboutSettings (a drawer), a standard view since PLAN-0.4.0. Renders
// the product intro markdown; the window header carries the page title, so the
// drawer chrome is gone. Content re-featured per release rather than drifting
// back to an era-stale feature list — the 0.4.1 pass carries the 0.4.0 rewrite
// plus the 0921/0922 waves (routine CSV batch, per-conversation models,
// run-time keep-awake), and the two intro paragraphs name the SHIPPING version
// (the footer's __APP_VERSION__ already follows package.json on its own).
// NOTE: the markdown lives in JS template literals — never emit a backtick or
// an interpolation (a `${`) into the strings below.

import React from 'react'
import { Typography } from 'antd'
import { XMarkdown } from '@ant-design/x-markdown'
import { useTranslation } from '../../i18n/useTranslation'
import CenteredPage from '../layout/CenteredPage'
import { useMarkdownThemeClass } from '../../theme/mode'

const { Text } = Typography

const productIntroMdZh = `
# PulseMind

> 每一次脉动，皆是智能。

PulseMind 是一款本地优先的桌面端 AI 助手，搭载自主 Agent 引擎。0.4.1 是一次全面重铸的大版本：全新的信息架构，项目工作区与日常任务自动化，@召唤专家并行协作，字节级保真的 Office 文档编辑与导出，富预览与预览即编辑，以及随身的浏览器扩展。所有数据都保存在你自己的电脑上。

## 快速开始

### 连接模型

进入「设置 → 模型设置」，配置你的大语言模型：

- **提供商** — Anthropic、OpenAI 或任意 OpenAI 兼容接口（含国内厂商）
- **模型** — 要使用的模型名称
- **API 密钥** — 仅存储在本地
- **基础 URL** — 代理或兼容接口的自定义地址

配置好后来一下「测试连接」：一键验证，直接告诉你通没通。支持创建多套配置，按任务随时切换。

### 助手设置

- **我的称呼** — 助手在对话里怎么称呼你
- **助手名称** — 助手自己的名字
- **助手灵魂** — 它的个性、价值观与行为准则

## 全新的信息架构

- **欢迎页** — 「试试」快捷提示词一键开聊；对话 / 项目两个视角；项目、日常、知识三类卡片把下一步放在眼前
- **侧栏** — 新建任务 / 搜索 / 日常任务 / 能力 • 知识 • 创作
- **设置页** — 常规（语言、外观、开机自启、数据清理、运行上限、默认工作区）/ 模型设置 / 浏览器插件 / 快捷键 / 助手设置 / 记忆 / 经验 / 高级（阻止休眠、调试、Git 状态注入、知识自动编译）/ 关于；界面浅色 / 深色 / 跟随系统
- **⌘K 命令面板与原生菜单** — 常用动作键入即达，快捷键可自定义
- **全局搜索** — 会话、消息、记忆、知识，一处直达
- **会话列表** — 置顶 / 今天 / 昨天 / 更早 自动分组

## 项目

给 AI 一个专属文件夹，它就能在这里读写文件、持续推进。

- **命名工作区** — 每个项目一个文件夹、一个专属身份色，项目下的会话自动归档
- **项目概述** — 一句话介绍项目（50 字以内），随消息注入上下文，AI 不必每次重新摸索
- **欢迎页卡片** — 继续上次对话，或立即开始新任务
- **排序** — 拖拽最顺手，也支持按创建时间 / 名称 / 最近活动

## 日常任务

把重复的事交给日程，到点自动执行。

- **例行任务** — 定时（cron）或手动触发，独立会话运行，完成后通知你
- **CSV 批量运行** — 给任务挂一个 CSV，每行数据用独立会话执行一次任务；并发与单次超时可调，运行历史按行展示，点击钻入该行的会话
- **运行历史** — 按天分桶，可删除、清理、设置保留期限
- **推荐模板** — 五个职场常用任务，点击带入编辑器，改改就能用
- **对话式配置** — 用聊天的方式填表；先出提案卡片，确认后才落库
- **从对话提炼** — 一段好用的对话，可以直接提炼为例行任务

## @召唤专家

- **@一位专家** — 结论原文直接进入对话，不再被主代理转述稀释
- **@多位专家** — 自动进入计划模式：主代理为每位专家分配任务节点，并行执行（同一会话最多 5 位同时运行），节点逐一验收
- **会话下钻** — 点开专家卡片，子代理的完整会话尽收眼底
- **同源能力** — 专家与全局共用工具、连接器与技能，差异只体现在身份与知识上

## 计划系统

- **结构化推进** — 复杂任务拆成计划（create_plan / advance_plan），逐步执行
- **状态分明** — 节点的执行与验收分开记录，「执行中」「已交付，待验收」一目了然
- **计划画布** — DAG 全景 100% 呈现，平移浏览，节点下钻

## 工具系统

41 个内置工具，默认全部启用：

- 文件读写 / 编辑 / 搜索 / 修补，目录浏览
- 终端命令执行，实时输出
- Git 状态 / 差异 / 日志 / 提交 / 恢复
- 网页访问与内置浏览器
- 记忆 / 知识 / 经验 / 历史会话 / 工具结果检索
- 计划与子代理编排

**授权三档**——始终询问 / 按需确认 / 全部允许，按会话记忆，输入框一键切换；工具执行以动词标签、结果徽章、diff 高亮和执行叙事呈现，每一步都看得懂。

## 浏览器

- **内置浏览器面板** — 多标签、地址栏历史、即时切换；页面快照带编号引用，AI 精准定位元素
- **浏览器扩展** — 任意网页右下角点开悬浮球，展开同款对话面板；8 个页面工具直接操作你正在看的标签页，授权与模型在面板里即可切换
- **安装** — 「设置 → 浏览器插件」提供服务开关、插件包下载与安装指南

## Office 文档

- **字节级保真编辑** — docx_edit / xlsx_edit / pptx_edit 只改要改的，未触碰的部分逐字节不变，最大程度保留原文档的格式与兼容性
- **样式操作** — PPT 支持加粗、字号、颜色、形状填充、页面背景与几何尺寸
- **结构先行** — office_inspect 让 AI 编辑前先看清文档结构
- **安全护栏** — 每次编辑展示结果 diff；结构校验不过，整批拒绝、一字不写；首次编辑自动备份
- **一键导出** — export_document 从 Markdown 生成 Word / Excel / PPT / PDF，永不覆盖已有文件，成品在预览面板即点即看

## 富预览与预览即编辑

- **开箱即看** — Markdown / 文本 / 代码 / CSV / HTML（沙箱隔离）/ 图片 / Word 分页 / Excel 网格 / PDF
- **预览即编辑** — 文件面板不只是渲染，还能直接改
- **HTML 元素编辑** — 元素面板按类型编辑，双击就地改文字，逐步撤销，或一句话让 AI 改

## 产物

每个回合结束，产物卡片列出本回合写出的所有文件，点击直达预览——交付不靠翻聊天记录。

## 知识中心

- **多知识库** — 按主题分组，导入、编译、检索按库进行
- **收藏入库** — 聊天里点一下收藏，消息自动成为知识条目；单向收录，管理在知识中心
- **LLM Wiki 编译** — 原始材料自动编译为结构化知识：来源摘要 / 实体 / 概念 / 综合文章，自带索引，对话中即问即查

## 能力中心

专家 / 连接器 / 技能 / 内置工具，四个分区一个页面：

- **专家** — 人设、方法论、输出规范、边界约束，再绑上一份私有知识
- **连接器** — 注册任意 MCP 服务器，扩展 AI 的能力边界
- **技能** — ZIP 技能包，SKILL.md 深度塑造行为，关键词自动触发
- **内置工具** — 41 个默认全开，用不上的可以按需关掉

## 创作中心

自己做工具，三件套起步：

- **清单 + 页面 + 存储** — 一个清单文件声明工具，一张页面就是界面，数据存在各自的 KV 里
- **工作室** — 实时预览，对话式迭代
- **模板** — 内置一组工具模板，改改就能用

## 一直都在的核心能力

- **Agent 引擎** — 自主循环、流式渲染、上下文自动压缩
- **多模型** — Anthropic / OpenAI 双协议适配，多套配置自由切换，单个会话还可单独指定模型
- **记忆** — 手动编写 + 会话后自动提取 + 全文检索
- **经验** — 对话结束自动萃取，最多 20 条、按最近使用淘汰，不重复交学费
- **会话与统计** — 本地 SQLite 存储，自动标题、自动清理；Token 用量按小时 / 日 / 月统计
- **双语** — 中文 / English 即时切换，当前语言自动注入提示词
`

const productIntroMdEn = `
# PulseMind

> Live Intelligence, In Every Pulse.

PulseMind is a local-first desktop AI assistant powered by its own agent engine. 0.4.1 is a ground-up release: a new information architecture, project workspaces and routine automation, parallel expert collaboration through @-summons, byte-faithful Office document editing and export, rich previews with in-place editing, and a browser extension that travels with you. All data stays on your own machine.

## Quick Start

### Connect a Model

Go to Settings → Models and configure your LLM:

- **Provider** — Anthropic, OpenAI, or any OpenAI-compatible service
- **Model** — the model name to use
- **API Key** — stored locally only
- **Base URL** — custom endpoint for proxies or compatible interfaces

Then hit Test Connection: one click, and it tells you in plain words whether the profile works. Create multiple profiles and switch per task.

### Assistant Settings

- **My Name** — how the assistant addresses you
- **Assistant Name** — the assistant's own name
- **Assistant Soul** — its personality, values, and behavioral guidelines

## A New Information Architecture

- **Welcome page** — one-click starters under Try these; a chats view and a projects view; project, routine, and knowledge cards keep the next step within reach
- **Sidebar** — New Task / Search / Routines / Capability · Knowledge · Studio
- **Settings** — General (language, appearance, launch at login, data cleanup, run limits, default workspace) / Models / Extension / Shortcuts / Assistant / Memory / Experiences / Advanced (keep-awake, debugging, Git injection, knowledge auto-compile) / About; light / dark / system appearance
- **⌘K command palette & native menu** — type to reach any common action, with rebindable shortcuts
- **Global search** — conversations, messages, memories, knowledge: one place
- **Conversation list** — auto-grouped into Pinned / Today / Yesterday / Earlier

## Projects

Give the AI a folder of its own, and it can read, write, and keep pushing the work forward.

- **Named workspace** — one folder and one identity color per project; its conversations file themselves under it
- **Project overview** — one sentence (up to 50 characters) injected into every prompt, so the AI never re-explores from scratch
- **Welcome cards** — continue the last conversation, or start a new task right away
- **Ordering** — drag to reorder, or sort by created / name / recent activity

## Routines

Hand the repetitive work to a schedule and let it run itself.

- **Routines** — cron-scheduled or manual, each run in its own session, with a notification when it finishes
- **CSV batch runs** — point a routine at a CSV and each data row runs the task in its own session; concurrency and the per-row timeout are adjustable, and the run history lists every row, clickable into its session
- **Run history** — bucketed by day; delete, clear, or set a retention window
- **Starter templates** — five workplace templates, one click into the editor
- **Conversational setup** — fill the form by chatting; a proposal card comes first, and nothing is saved until you confirm
- **Distill from a conversation** — turn a conversation that worked into a routine

## @-Summon Experts

- **Summon one expert** — the conclusion lands in the conversation verbatim, never diluted by a second-hand summary
- **Summon several** — plan mode kicks in automatically: the main agent assigns plan nodes to each expert and they run in parallel (up to 5 per session), each node accepted in turn
- **Session drill-in** — open an expert's card to read its sub-agent session in full
- **Shared capability** — experts use the global tools, connectors, and skills; identity and knowledge are the only difference

## Plan System

- **Structured progress** — complex tasks become plans (create_plan / advance_plan), worked step by step
- **Distinct states** — execution and acceptance are recorded separately; In progress and Delivered, pending acceptance are never conflated
- **Plan canvas** — the DAG always at 100%, pan to browse, drill into nodes

## Tool System

41 built-in tools, all enabled by default:

- file read/write/edit/search/patch and directory listing
- terminal commands with live output
- Git status / diff / log / commit / restore
- web access and the built-in browser
- memory / knowledge / experience / conversation / tool-result search
- plan and sub-agent orchestration

**Three approval levels** — always ask / ask as needed / allow all — remembered per conversation, switchable from the composer; tool runs are narrated with verb labels, result badges, diff highlights, and an activity story, so every step reads clearly.

## Browser

- **Built-in browser pane** — tabs, address-bar history, instant switching; snapshots carry numbered references so the AI points at exactly the right element
- **Browser extension** — the floating orb on any web page opens the same conversation panel; 8 page tools operate on the tab you are looking at, with approval level and model switchable right in the panel
- **Install** — Settings → Extension has the service toggle, the extension download, and the guide

## Office Documents

- **Byte-faithful editing** — docx_edit / xlsx_edit / pptx_edit change only what you change; untouched parts stay byte-identical, preserving the original document's formatting and compatibility
- **Styling ops** — PPTX supports bold, size, color, shape fill, slide background, and geometry
- **Inspect first** — office_inspect shows the document's structure before editing
- **Safety rails** — every edit shows a result diff; a failed structural check refuses the whole batch and writes nothing; the first edit is backed up automatically
- **One-step export** — export_document generates Word / Excel / PPT / PDF from Markdown, never overwriting an existing file; results open straight into the preview pane

## Rich Previews & In-Place Editing

- **Opens everything** — Markdown / text / code / CSV / HTML (sandboxed) / images / Word pages / Excel grid / PDF
- **Preview becomes editing** — the file pane does not just render, it edits
- **HTML element editing** — a type-aware element panel, double-click to edit text in place, step-by-step undo, or one sentence for the AI to do it

## Deliverables

At the end of every turn, a deliverables card lists every file written in that turn — click through to preview. Hand-offs no longer mean scrolling through the transcript.

## Knowledge Center

- **Multiple bases** — grouped by topic; import, compile, and search per base
- **Favorites become knowledge** — one click on a message files it into the knowledge base; one-way by design, managed in the center
- **LLM Wiki compilation** — raw material is compiled into structured knowledge across source summaries / entities / concepts / syntheses, with its own index, searchable in conversation

## Capability Center

Experts / connectors / skills / built-in tools — four sections, one page:

- **Experts** — persona, methodology, output conventions, boundaries, plus a bound private knowledge pack
- **Connectors** — register any MCP server to extend what the AI can reach
- **Skills** — ZIP skill packs; SKILL.md shapes behavior deeply, trigger keywords fire automatically
- **Built-in tools** — all 41 on by default; switch off the ones you do not need

## Studio

Build your own tools from three pieces:

- **Manifest + page + storage** — a manifest declares the tool, a page is the interface, data lives in a per-tool KV store
- **Studio** — live preview, conversational iteration
- **Templates** — built-in tool templates to start from

## The Core That Was Always Here

- **Agent engine** — autonomous loop, streaming rendering, automatic context compaction
- **Multi-model** — Anthropic and OpenAI protocols via adapters; switch profiles freely, or pin a different model to a single conversation
- **Memory** — hand-written + auto-extracted after sessions + full-text search
- **Experiences** — distilled after conversations, 20 at most with LRU eviction, so lessons are never paid for twice
- **Sessions & usage** — local SQLite storage, auto titles, auto cleanup; token usage charted by hour / day / month
- **Bilingual** — Chinese and English switch instantly; the active language rides the prompt
`

function AboutPage(): React.ReactElement {
  const { locale } = useTranslation()
  const content = locale === 'zh' ? productIntroMdZh : productIntroMdEn
  const mdClass = useMarkdownThemeClass()

  return (
    <CenteredPage>
      <div className={mdClass} style={{ fontSize: 14, lineHeight: 1.8 }}>
        <XMarkdown content={content} />
      </div>
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--pm-border-hairline)', textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          PulseMind v{__APP_VERSION__}
        </Text>
      </div>
    </CenteredPage>
  )
}

export default AboutPage
