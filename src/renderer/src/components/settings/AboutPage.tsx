// ── About page ──
// Formerly AboutSettings (a drawer), a standard view since PLAN-0.4.0. Renders
// the product intro markdown; the window header carries the page title, so the
// drawer chrome is gone. Content re-featured per release rather than drifting
// back to an era-stale feature list — the 0.4.3 pass carries the memory-wiki
// unification (four-type memory pages, scheduled extraction, the curated
// compile pass with retire/restore), the experience-as-skill ruling (the skill
// center's three sections, SKILL-standard manuals, one-click SOP distillation,
// pick_skill pulling experiences), recall as the one federated search, the
// workbench address bar + draggable splits, background-task wakeup, sub-agent
// follow-up, the network proxy (packet debugging), the 12h unattended
// hardening batch, and the execution-guardrails batch (read-before-write and
// the four gates, CSP'd artifact cards). The two intro paragraphs name the
// SHIPPING version (the footer's __APP_VERSION__ already follows package.json
// on its own). Deliberately NOT mentioned: the routine webhook trigger and the
// settlement webhook — ROUTINE_WEBHOOK_UI keeps both surfaces hidden (backend
// keeps working), so the fact sheet hides them with it. The tool count is
// BUILT_IN_TOOLS.length (33): page tools are extension-only and
// create_sub_plan is expert-scoped, neither is counted. Settings-page list
// mirrors the MENU in SettingsPage.tsx (常规/模型设置/浏览器插件/快捷键/
// 助手设置/记忆/高级/关于 — 经验 is no longer its own section; it lives in
// the skill center's third section, memory browsing moved under 记忆).
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

PulseMind 是一款本地优先的桌面端 AI 助手，搭载自主 Agent 引擎。0.4.3 重排了 AI 的记性与本领：记忆与经验统一为可全文检索的记忆页，自动提取、自动整理、可退役可恢复；经验按技能手册的标准沉淀，确定性流程可一键固化为带脚本与验证证据的 SOP；recall 一个口子查遍记忆、历史会话与知识库。工作台换上地址栏与可拖拽分栏，后台任务完成自动唤醒对话，对外请求可统一挂代理抓包调试；长会话无人值守更稳，AI 执行护栏更严。所有数据都保存在你自己的电脑上。

## 快速开始

### 连接模型

进入「设置 → 模型设置」，分两层配置你的大语言模型：

- **供应商** — 一条共享连接：接口规范（Anthropic 或 OpenAI 兼容）、基础 URL、API 密钥与自定义请求头；一个供应商可挂多个模型，全部复用这条连接
- **模型** — 供应商名下的每个模型各自保存模型名、显示名、最大输出与上下文长度
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
- **设置页** — 常规（语言、外观、会话与运行记录保留、运行上限、专家并发上限、默认工作区）/ 模型设置 / 浏览器插件 / 快捷键 / 助手设置 / 记忆 / 高级（网络代理、LLM 重试状态码、阻止休眠、调试、Git 状态注入、项目命令注入、知识自动编译）/ 关于；界面浅色 / 深色 / 跟随系统
- **⌘K 命令面板与原生菜单** — 常用动作键入即达，快捷键可自定义
- **全局搜索** — 会话、消息、记忆、知识，一处直达
- **会话列表** — 置顶 / 今天 / 昨天 / 更早 自动分组

## 项目

给 AI 一个专属文件夹，它就能在这里读写文件、持续推进。

- **命名工作区** — 每个项目一个文件夹、一个专属身份色，项目下的会话自动归档
- **项目概述** — 一句话介绍项目（50 字以内），随消息注入上下文，AI 不必每次重新摸索
- **欢迎页卡片** — 继续上次对话，或立即开始新任务
- **排序** — 拖拽最顺手，也支持按创建时间 / 名称 / 最近活动

## 工作台

AI 写下的每个文件都在这里：地址栏把工作区路径铺成面包屑，点一层跳一层。

- **拖拽分栏** — 侧栏与「目录树 ↔ 预览」的宽度都能拖拽调整，小窗不挤、宽屏不空，布局自动记住
- **文件 tab 预览** — 目录树选中即预览，多个文件并排开着不迷路

## 日常任务

把重复的事交给日程，到点自动执行。

- **例行任务** — 定时（cron）、手动或文件变化触发（监听指定文件 / 文件夹），独立会话运行，完成后通知你
- **CSV/Excel 批量运行** — 给任务挂一个 CSV 或 Excel（首张工作表，最大 50MB），表头自动映射为任务参数；每行数据用独立会话执行一次任务，并发与单次超时可调，中断可续跑，运行历史按行展示，点击钻入该行的会话
- **运行历史** — 按天分桶，可删除、清理、设置保留期限
- **推荐模板** — 五个职场常用任务，点击带入编辑器，改改就能用
- **对话式配置** — 用聊天的方式填表；先出提案卡片，确认后才落库
- **从对话提炼** — 一段好用的对话，可以直接提炼为例行任务

## 记忆

从 0.4.3 起，记忆与经验统一为「记忆页」：一处提取、一处检索、一处整理。

- **四类页面** — 偏好 / 决策 / 事实 / 经验，语义分明，全库 trigram 全文索引
- **定时提取** — 按设置的间隔自动从会话中提取新页（默认 6 小时，可关），也可随时手动触发
- **自动整理** — 池子增大时自动归并重复页、更新过时内容；判过时的页退役留档、随时可恢复，带脚本的经验页永不误动
- **手动记忆** — MEMORY.md 手写内容永远注入每一段系统提示词
- **记忆浏览** — 「设置 → 记忆」里浏览、搜索、恢复已退役页

## 经验

经验是从对话里长出来的做事方法，按技能的标准沉淀。

- **两阶段沉淀** — 会话结束先萃取线索；同一线索反复出现会被记为「重现」，那正是最值得固化的信号
- **技能手册标准** — 每条经验写成「适用场景 / 步骤 / 注意事项」的手册，写给未来的会话执行，不是流水账
- **固化为 SOP** — 确定性流程一键进入无人值守验证会话：重走一遍流程、留下脚本与验证证据，通过才升格
- **即技能** — 经验卡与技能卡同壳同开关：可停用、可查看、可删除，就住在技能中心的「经验」分区
- **按需拉取** — AI 干活前按名或按意图拉取技能与经验全文，用得上才进上下文

## @召唤专家

- **@一位专家** — 结论原文直接进入对话，不再被主代理转述稀释
- **@多位专家** — 自动进入计划模式：主代理为每位专家分配任务节点，并行执行（同一会话默认最多 5 位同时运行，可在「设置 → 常规」调整），节点逐一验收
- **会话下钻** — 点开专家卡片，子代理的完整会话尽收眼底
- **续聊追问** — 对已经跑完的专家继续追问，它的完整上下文原样保留，不必重新交代背景
- **同源能力** — 专家与全局共用工具、连接器与技能，差异只体现在身份与知识上

## 计划系统

- **结构化推进** — 复杂任务拆成计划（create_plan / advance_plan），逐步执行
- **状态分明** — 节点的执行与验收分开记录，「执行中」「已交付，待验收」一目了然
- **计划画布** — DAG 全景 100% 呈现，平移浏览，节点下钻

## 工具系统

33 个内置工具，默认全部启用：

- 文件读写 / 编辑 / 搜索 / 修补，目录浏览；读取自带行号坐标，改哪一行说得清
- 终端命令执行，实时输出；后台任务完成自动唤醒会话，不用轮询
- Git 状态 / 差异 / 日志 / 提交 / 恢复
- 网页访问与内置浏览器
- **recall 统一检索** — 记忆页、历史会话、知识库一次查完
- 计划与子代理编排

**授权三档**——始终询问 / 按需确认 / 全部允许，按会话记忆，输入框一键切换；工具执行以动词标签、结果徽章、diff 高亮和执行叙事呈现，每一步都看得懂。

## 浏览器

- **内置浏览器面板** — 多标签、地址栏历史与收藏、即时切换；页面快照带原生引用编号，每步只发差异、iframe 内容一并可见，AI 精准定位元素
- **收藏** — 地址栏星标收藏常用站点，新标签页直达；也可以对 AI 说「打开我收藏的知乎」，按名字取址、不靠猜
- **浏览器扩展** — 任意网页右下角点开悬浮球，展开同款对话面板；8 个页面工具直接操作你正在看的标签页，HTML 产物卡在面板里同样可预览
- **安装** — 「设置 → 浏览器插件」提供服务开关、插件包下载与安装指南

## Office 文档

- **字节级保真编辑** — office_edit 只改要改的（docx / xlsx / pptx）：docx / pptx 未触碰部分逐字节不变，xlsx 保格式保值但整簿重写，最大程度保留原文档的格式与兼容性
- **表达力完整** — Word 生成可嵌图、编辑可增删表格行；Excel 可设样式、列宽与冻结窗格，生成端表头加粗、列宽自适应
- **设计路线生成** — PPT 从零生成走设计路线：模型先落主题（tokens.css）再写版式（deck.html），引擎用 Chromium 实测布局，输出原生可编辑形状（不是截图）并附保真报告；Markdown 大纲是纯文字的兜底路线
- **先定位后精读** — office_inspect 看清结构，office_read 按大纲分页读，office_search 坐标锚定的内容搜索——百页大文档也不再盲翻
- **安全护栏** — 每次编辑展示结果 diff；结构校验不过，整批拒绝、一字不写；首次编辑自动备份
- **一键导出** — export_document 从 Markdown 生成 Word / Excel / PPT / PDF，永不覆盖已有文件，成品在预览面板即点即看

## 数据安全

- **目录权限收紧** — 数据目录默认仅本用户可读（0700/0600），启动时自动修复历史遗留权限
- **密钥加密（可选启用）** — 在 settings.json 中把 encryptSecrets 设为 true 后生效：API 密钥经系统钥匙串加密落盘（enc:v1:）；默认明文落盘，靠目录权限（0600）与磁盘加密防护；环境变量占位符两种模式下照常可用
- **AI 执行护栏** — 编辑文件前必须先读；终端重定向写文件、已完成任务的重复派发、项目指令文件改动都有硬门拦截；HTML 产物卡片走 CSP 白名单；网络出口带 SSRF 防护与路径消毒
- **备份与残留治理** — 数据库备份默认保留 30 天，调试请求转储 7 天过期；压缩或删除会话后的残留数据行自动对账清除，过期会话的工作区目录一并回收
- **数据不出机** — 对话、记忆、知识、经验全部存本地 SQLite，不依赖任何云端

## 富预览与预览即编辑

- **开箱即看** — Markdown / 文本 / 代码 / CSV / HTML（沙箱隔离）/ 图片 / Word 分页 / PPT 幻灯片 / Excel 网格 / PDF
- **预览即编辑** — 文件面板不只是渲染，还能直接改
- **HTML 元素编辑** — 元素面板按类型编辑，双击就地改文字，逐步撤销，或一句话让 AI 改

## 产物

每个回合结束，产物卡片列出本回合写出的所有文件，点击直达预览——交付不靠翻聊天记录。

## 知识中心

- **多知识库** — 按主题分组，导入、编译、检索按库进行
- **收藏入库** — 聊天里点一下收藏，消息自动成为知识条目；单向收录，管理在知识中心
- **LLM Wiki 编译** — 原始材料自动编译为结构化知识：来源摘要 / 实体 / 概念 / 综合文章，自带索引
- **原文直达** — 检索命中返回文档路径，AI 直接读取原文作答，不吃转述

## 能力中心

专家 / 连接器 / 技能 / 内置工具，四个分区一个页面：

- **专家** — 人设、方法论、输出规范、边界约束，外加可用技能与连接器的白名单
- **连接器** — 注册任意 MCP 服务器，扩展 AI 的能力边界
- **技能** — ZIP 技能包，SKILL.md 深度塑造行为，关键词自动触发；中心三分区：内置 / 已安装 / 经验
- **内置工具** — 33 个默认全开，用不上的可以按需关掉

## 创作中心

自己做工具，三件套起步：

- **清单 + 页面 + 存储** — 一个清单文件声明工具，一张页面就是界面，数据存在各自的 KV 里
- **工作室** — 实时预览，对话式迭代
- **模板** — 内置一组工具模板，改改就能用

## 一直都在的核心能力

- **Agent 引擎** — 自主循环、流式渲染（正文句尾一枚光标）、上下文自动压缩
- **多模型** — Anthropic / OpenAI 双协议适配，模型按供应商分组共享凭据，单个会话还可单独指定模型
- **记忆** — 手写 MEMORY.md 永远注入，其余自动提取、整理为记忆页（见「记忆」）
- **经验** — 会话后自动萃取，可固化为 SOP（见「经验」）
- **会话与统计** — 本地 SQLite 存储，自动标题（第三条消息后还会重写得更准）、自动清理；Token 用量按小时 / 日 / 月统计，缓存命中单独记账
- **长跑更稳** — 闲置会话自动逐出内存、终端输出封顶、网络断流自动续跑、调度槽位不再卡死——12 小时无人值守也不失控
- **双语** — 中文 / English 即时切换，当前语言自动注入提示词
`

const productIntroMdEn = `
# PulseMind

> Live Intelligence, In Every Pulse.

PulseMind is a local-first desktop AI assistant powered by its own agent engine. 0.4.3 reorganizes what the AI remembers and what it can do: memories and experiences are unified into full-text-searchable memory pages — extracted, curated, retired and restorable; experiences are written to the skill manual standard, and deterministic workflows distill into SOPs with scripts and verification evidence in one click; a single recall call searches memories, past conversations, and the knowledge base. The workbench gains an address bar and draggable splits, finished background tasks wake the conversation on their own, all outbound traffic can ride a proxy for packet-level debugging, long unattended sessions hold steady, and the AI's execution guardrails are stricter. All data stays on your own machine.

## Quick Start

### Connect a Model

Go to Settings → Models and configure your LLM in two layers:

- **Provider** — a shared connection: API format (Anthropic or OpenAI-compatible), Base URL, API Key, and custom headers. One provider can host many models, and they all reuse its connection.
- **Models** — each model under the provider keeps its own model name, display name, max output tokens, and context length.
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
- **Settings** — General (language, appearance, conversation & run retention, run limits, expert concurrency, default workspace) / Models / Extension / Shortcuts / Assistant / Memory / Advanced (network proxy, LLM retry codes, keep-awake, debugging, Git injection, project-commands injection, knowledge auto-compile) / About; light / dark / system appearance
- **⌘K command palette & native menu** — type to reach any common action, with rebindable shortcuts
- **Global search** — conversations, messages, memories, knowledge: one place
- **Conversation list** — auto-grouped into Pinned / Today / Yesterday / Earlier

## Projects

Give the AI a folder of its own, and it can read, write, and keep pushing the work forward.

- **Named workspace** — one folder and one identity color per project; its conversations file themselves under it
- **Project overview** — one sentence (up to 50 characters) injected into every prompt, so the AI never re-explores from scratch
- **Welcome cards** — continue the last conversation, or start a new task right away
- **Ordering** — drag to reorder, or sort by created / name / recent activity

## Workbench

Every file the AI writes lives here: the address bar lays the workspace path out as breadcrumbs — click a segment to jump there.

- **Draggable splits** — the sidebar and the tree ↔ preview divider both drag; narrow windows stay usable, wide ones stay filled, and the layout is remembered
- **File tabs** — select in the tree to preview; several files stay open side by side

## Routines

Hand the repetitive work to a schedule and let it run itself.

- **Routines** — cron-scheduled, manual, or fired by file changes (watching files or folders you name), each run in its own session, with a notification when it finishes
- **CSV/Excel batch runs** — point a routine at a CSV or an Excel sheet (first worksheet, up to 50MB) and headers map themselves into task parameters; each data row runs the task in its own session, concurrency and the per-row timeout are adjustable, interrupted batches resume, and the run history lists every row, clickable into its session
- **Run history** — bucketed by day; delete, clear, or set a retention window
- **Starter templates** — five workplace templates, one click into the editor
- **Conversational setup** — fill the form by chatting; a proposal card comes first, and nothing is saved until you confirm
- **Distill from a conversation** — turn a conversation that worked into a routine

## Memory

From 0.4.3, memories and experiences are unified as memory pages: one place to extract, one place to search, one place to curate.

- **Four page types** — preferences / decisions / facts / experiences, each with its own meaning under one search, full-library trigram indexing
- **Scheduled extraction** — new pages are pulled out of conversations on an interval you set (6 hours by default, can be turned off), or extracted on demand
- **Automatic curation** — as the pool grows, duplicates are merged and stale content updated; pages judged outdated are retired with their reason on file and restorable any time, and script-bearing experience pages are never touched
- **Hand-written memory** — MEMORY.md is injected into every system prompt, always
- **Memory browser** — browse, search, and restore retired pages under Settings → Memory

## Experiences

Experiences are working methods grown out of your conversations, distilled to the skill standard.

- **Two-phase distillation** — a session first yields clues; when the same clue keeps recurring it is recorded as a recurrence — exactly the signal worth solidifying
- **The skill manual standard** — each experience is written as a manual of when to use it / steps / cautions, addressed to future sessions, not a diary
- **Distill into an SOP** — one click sends a deterministic workflow into an unattended verification session: it re-walks the flow and leaves scripts plus verification evidence; only a pass is promoted
- **Experiences are skills** — same card shell, same on/off switch: disable, inspect, delete; they live in the Experiences section of the skill center
- **Pulled on demand** — before working, the AI fetches skill and experience full texts by name or intent; only what applies enters the context

## @-Summon Experts

- **Summon one expert** — the conclusion lands in the conversation verbatim, never diluted by a second-hand summary
- **Summon several** — plan mode kicks in automatically: the main agent assigns plan nodes to each expert and they run in parallel (up to 5 per session by default, adjustable in Settings → General), each node accepted in turn
- **Session drill-in** — open an expert's card to read its sub-agent session in full
- **Follow-up questions** — keep asking a finished expert; its full context is kept verbatim, no need to re-explain the background
- **Shared capability** — experts use the global tools, connectors, and skills; identity and knowledge are the only difference

## Plan System

- **Structured progress** — complex tasks become plans (create_plan / advance_plan), worked step by step
- **Distinct states** — execution and acceptance are recorded separately; In progress and Delivered, pending acceptance are never conflated
- **Plan canvas** — the DAG always at 100%, pan to browse, drill into nodes

## Tool System

33 built-in tools, all enabled by default:

- file read/write/edit/search/patch and directory listing; reads carry line-number coordinates, so edits name the exact line
- terminal commands with live output; finished background tasks wake the conversation on their own — no polling
- Git status / diff / log / commit / restore
- web access and the built-in browser
- **one-call recall** — memory pages, past conversations, and the knowledge base in a single query
- plan and sub-agent orchestration

**Three approval levels** — always ask / ask as needed / allow all — remembered per conversation, switchable from the composer; tool runs are narrated with verb labels, result badges, diff highlights, and an activity story, so every step reads clearly.

## Browser

- **Built-in browser pane** — tabs, address-bar history and favorites, instant switching; snapshots carry native ref numbers, send only the diff per step, and see into iframes, so the AI points at exactly the right element
- **Favorites** — star sites in the address bar and reach them from the new-tab page; or just tell the AI "open my favorited Zhihu" — it resolves by name instead of guessing
- **Browser extension** — the floating orb on any web page opens the same conversation panel; 8 page tools operate on the tab you are looking at, and HTML artifact cards preview right in the panel too
- **Install** — Settings → Extension has the service toggle, the extension download, and the guide

## Office Documents

- **Byte-faithful editing** — office_edit (docx / xlsx / pptx) changes only what you change; untouched parts stay byte-identical, preserving the original document's formatting and compatibility
- **Full expressiveness** — Word generation embeds images and edits table rows; Excel gains styles, column widths, and freeze panes, and generated sheets get bold headers with fitted widths
- **The design route** — PPT generation from scratch goes through the design route: the model pins a theme (tokens.css) and writes the layout (deck.html); the engine measures the real layout with Chromium and emits native editable shapes (not screenshots) with a fidelity report; a Markdown outline stays as the plain-text fallback
- **Locate, then read** — office_inspect shows the structure, office_read pages through the outline, office_search is coordinate-anchored content search — hundred-page documents no longer get skimmed blind
- **Safety rails** — every edit shows a result diff; a failed structural check refuses the whole batch and writes nothing; the first edit is backed up automatically
- **One-step export** — export_document generates Word / Excel / PPT / PDF from Markdown, never overwriting an existing file; results open straight into the preview pane

## Data Security

- **Tightened permissions** — the data directory is readable only by your user (0700/0600); startup repairs any legacy modes
- **Secret encryption (opt-in)** — active once encryptSecrets is set to true in settings.json: API keys are encrypted through the OS keychain (enc:v1:); the default is plaintext on disk, protected by file permissions (0600) and disk encryption; env-var placeholders keep working in either mode
- **AI execution guardrails** — files must be read before they are edited; terminal redirects that write files, re-dispatches of finished tasks, and project-instruction file edits all hit hard gates; HTML artifact cards run under a CSP allowlist; network egress carries SSRF protection and path sanitization
- **Backup & residue governance** — database backups default to 30 days and debug request dumps expire after 7; rows left behind by compaction or deletion are reconciled away, and expired conversations' workspace folders are reclaimed with them
- **Data stays local** — conversations, memories, knowledge, and experiences live in local SQLite, with no cloud dependency

## Rich Previews & In-Place Editing

- **Opens everything** — Markdown / text / code / CSV / HTML (sandboxed) / images / Word pages / PPT slides / Excel grid / PDF
- **Preview becomes editing** — the file pane does not just render, it edits
- **HTML element editing** — a type-aware element panel, double-click to edit text in place, step-by-step undo, or one sentence for the AI to do it

## Deliverables

At the end of every turn, a deliverables card lists every file written in that turn — click through to preview. Hand-offs no longer mean scrolling through the transcript.

## Knowledge Center

- **Multiple bases** — grouped by topic; import, compile, and search per base
- **Favorites become knowledge** — one click on a message files it into the knowledge base; one-way by design, managed in the center
- **LLM Wiki compilation** — raw material is compiled into structured knowledge across source summaries / entities / concepts / syntheses, with its own index
- **Straight to the source** — hits return document paths and the AI reads the original text, not a retelling

## Capability Center

Experts / connectors / skills / built-in tools — four sections, one page:

- **Experts** — persona, methodology, output conventions, boundaries, plus allow-lists of usable skills and connectors
- **Connectors** — register any MCP server to extend what the AI can reach
- **Skills** — ZIP skill packs; SKILL.md shapes behavior deeply, trigger keywords fire automatically; three sections in the center: Built-in / Installed / Experiences
- **Built-in tools** — all 33 on by default; switch off the ones you do not need

## Studio

Build your own tools from three pieces:

- **Manifest + page + storage** — a manifest declares the tool, a page is the interface, data lives in a per-tool KV store
- **Studio** — live preview, conversational iteration
- **Templates** — built-in tool templates to start from

## The Core That Was Always Here

- **Agent engine** — autonomous loop, streaming rendering (a single caret at the sentence tail), automatic context compaction
- **Multi-model** — Anthropic and OpenAI protocols via adapters; group models under shared-credential providers, or pin a different model to a single conversation
- **Memory** — hand-written MEMORY.md always injected; everything else extracted and curated into memory pages (see Memory)
- **Experiences** — distilled after sessions, distillable into SOPs (see Experiences)
- **Sessions & usage** — local SQLite storage, auto titles (rewritten once more accurately after the third message), auto cleanup; token usage charted by hour / day / month, with cache hits accounted separately
- **Long runs hold** — idle conversations evicted from memory, terminal output capped, interrupted streams auto-resume, scheduler slots never wedge — 12 hours unattended without losing control
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
