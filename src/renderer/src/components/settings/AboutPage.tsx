// ── About page ──
// Formerly AboutSettings (a drawer), a standard view since PLAN-0.4.0. Renders
// the product intro markdown; the window header carries the page title, so the
// drawer chrome is gone.

import React from 'react'
import { Typography } from 'antd'
import { XMarkdown } from '@ant-design/x-markdown'
import '@ant-design/x-markdown/themes/light.css'
import { useTranslation } from '../../i18n/useTranslation'
import CenteredPage from '../layout/CenteredPage'

const { Text } = Typography

const productIntroMdZh = `
# PulseMind

> 每一次脉动，皆是智能。

PulseMind 是一款桌面端 AI 助手应用，搭载自主 Agent 引擎，支持多模型提供商、工具调用、技能系统、记忆管理、MCP 协议扩展和可视化页面生成等特性。

## 快速开始

使用 PulseMind 前，需要先完成两个关键设置。

### LLM 设置
点击左侧设置按钮，配置您的 LLM（大语言模型）：

- **提供商** — 选择 Anthropic、OpenAI 或其他兼容的 API 提供商
- **模型** — 输入您要使用的模型名称
- **API 密钥** — 填入您的 API 密钥，密钥仅存储在本地
- **基础 URL** — 如需使用代理或兼容接口，可自定义请求地址

创建配置后，点击「使用此配置」即可激活。

### 助手设置
在「助手设置」中，您可以个性化 AI 助手的交互方式：

- **我的称呼** — 设置助手在对话中对您的称呼方式
- **助手名称** — 自定义助手在会话中显示的名称
- **助手灵魂** — 定义助手的核心个性、价值观和行为准则，让 AI 更贴合您的使用场景

完成以上设置后，即可开始新的对话。

## 核心特性

### Agent 引擎
自主 Agent 循环：用户消息 → LLM 流式响应 → 工具自动执行（只读工具免批、敏感操作需确认）→ 结果回传 → 继续循环直到完成。支持流式块实时渲染、自动上下文压缩（智能摘要旧工具结果以节省 Token 窗口）、子代理并发调用（标题生成、记忆提取、经验萃取、技能匹配等）。

### 专家系统
支持创建专家角色（人设 / 方法论 / 输出规范 / 边界约束 + 绑定私有知识），在对话里用 @ 召唤专家，任务会通过 spawn_agent 委托给该专家以子代理执行，结果回到当前对话；主 Agent 也可通过 spawn_agent 工具主动把任务委托给某个专家；专家与全局共用同一套工具、连接器与技能，能力差异只体现在身份与知识上。

### 多模型支持
通过适配器模式同时支持 Anthropic 和 OpenAI 两大协议，可接入任意兼容 OpenAI 接口的服务（包括国内大模型厂商）。支持创建多套 LLM 配置，在提供商、模型、密钥之间自由切换。

### 工具系统
内置 27 个工具，覆盖文件操作（读/写/编辑/搜索/修补）、命令执行（终端实时输出、跨平台）、浏览器操作、MCP 工具调用、记忆检索、知识库检索、经验读取、工具执行结果搜索、内联交互等场景。输入框的授权按钮提供始终询问 / 按需确认 / 全部允许三档，随时切换自主程度。

### MCP 协议扩展
集成 MCP（Model Context Protocol）服务器管理，可注册任意 MCP 服务器扩展 AI 能力。浏览器能力由应用内置（随包 Chromium，或系统 Chrome/Edge），无需额外配置即可完成导航、点击、输入、截图、内容提取。

### 技能系统
通过导入 .zip 技能包扩展 AI 能力。每个技能包含 SKILL.md 文件，设有 YAML 头部信息和系统提示模板，可深度塑造 AI 的行为方式。支持触发关键词自动激活。

### 知识库（LLM Wiki）
支持导入本地文件、网页 URL 到知识库。内置多格式提取（PDF、Office、代码文件等），由 LLM 自动将原始材料编译为结构化知识 Wiki —— 按来源摘要、实体、概念、综合文章四个维度组织，并自动构建带摘要的知识索引。LLM 在对话中可通过搜索工具直接检索和引用知识库内容。

### 经验系统
每次对话结束后，AI 会评估本次会话是否值得沉淀为「经验」——只有满足特定标准（复杂任务成功、撞墙后找到可行路径、被用户纠正、发现非平凡工作流）的交互才会被提取。经验以 SKILL 形式独立存储管理，最多保留 20 条，超出后按最近触发时间自动淘汰最久未使用的内容。对话中触发关键词自动匹配或 AI 主动检索即可调用经验，避免重复试错。

### 记忆系统
三重记忆体系：手动编写持久记忆 + 会话结束后自动提取关键信息 + 最近会话上下文。自动捕获的记忆按事实、决策、偏好等类型分类，支持 SQLite FTS5 全文搜索。

### Canvas 页面生成
可视化 HTML 页面生成模式：AI 生成代码 → iframe 实时预览 → 画布标注反馈 → 迭代优化。支持 WebGL 渐变加载动画、多区域并行生成、一键导出 HTML。

### 会话管理
所有对话持久化存储于本地 SQLite（WAL 模式），支持自动标题生成。每条消息可点赞、录入知识库、查看 Token 用量。支持自动清理旧会话。

### 知识库录入与统计
单条消息可一键录入知识库，以「收藏」来源保存并自动编译；没有可用模型配置时保留可检索的原文。录入不可撤销，需要删除时请前往知识中心。Token 用量按小时、日、月以堆叠柱状图展示，全部数据本地存储。

### Plan 任务规划
支持多步骤任务规划（create_plan / advance_plan），AI 可制定结构化执行计划并逐步推进，适合复杂工作流场景。

### 双语言支持
内置中文和 English 双语界面，即时切换。当前语言自动注入系统提示词，确保 AI 使用正确的语言回复。
`

const productIntroMdEn = `
# PulseMind

> Live Intelligence, In Every Pulse.

PulseMind is a desktop AI assistant powered by its own Agent engine, with multi-provider LLM support, tool calling, skill system, memory management, MCP protocol extension, and visual page generation.

## Quick Start

Two key settings are required before using PulseMind.

### LLM Settings
Click the settings button on the left to configure your LLM:

- **Provider** — Choose Anthropic, OpenAI, or any compatible API provider
- **Model** — Enter the model name you want to use
- **API Key** — Enter your API key; keys are stored locally only
- **Base URL** — Custom endpoint for proxy or compatible interfaces

After creating a profile, click "Use This Profile" to activate it.

### Assistant Settings
In the assistant settings, you can personalize the AI interaction:

- **My Name** — Sets how the assistant addresses you
- **Assistant Name** — Customizes the assistant's display name in conversation
- **Assistant Soul** — Defines the core personality, values, and behavioral guidelines

Once configured, you can start a new conversation.

## Core Features

### Agent Engine
Autonomous agent loop: user message → LLM streaming response → tool execution (read-only auto-approved, sensitive actions require confirmation) → result feedback → continue until complete. Features real-time streaming block rendering, automatic context compression (intelligently summarizes old tool results to save token window), concurrent sub-agents (title generation, memory extraction, experience distillation, skill matching).

### Sub-Agent System
Create custom agent roles with independently configured tool sets and behavior prompts. Built-in role templates include general assistant and canvas generator. The main agent can dynamically invoke sub-agents via the spawn_agent tool to collaborate on complex tasks.

### Multi-Model Support
Supports both Anthropic and OpenAI protocols via an adapter pattern. Compatible with any OpenAI-compatible API service. Create multiple LLM profiles and switch freely between providers, models, and keys.

### Tool System
27 built-in tools covering file operations (read/write/edit/search/patch), command execution (real-time terminal output), browser automation, MCP tool calls, memory retrieval, knowledge base search, experience reading, tool result search, and inline interaction. The composer's approval button switches between always-ask / ask-when-leaving-workspace / allow-all on the fly.

### MCP Protocol Extension
MCP (Model Context Protocol) server management — register any MCP server to extend AI capabilities. Browser capability ships with the app (bundled Chromium, or system Chrome/Edge), so navigation, clicking, typing, screenshots and content extraction work with no extra setup.

### Skill System
Import .zip skill packs to extend AI capabilities. Each skill includes a SKILL.md file with YAML frontmatter and system prompt template. Supports trigger keywords for automatic activation in relevant contexts.

### Knowledge Base (LLM Wiki)
Import local files and web URLs into the knowledge base. Built-in multi-format extraction (PDF, Office, code files, etc.) — raw materials are automatically compiled by the LLM into a structured knowledge Wiki organized across four dimensions: source summaries, entities, concepts, and syntheses, with an auto-built indexed catalog. The LLM can search and reference knowledge base content directly during conversations.

### Experience System
After each conversation, the AI evaluates whether the session deserves to be distilled into an "experience" — only interactions meeting specific criteria (successful complex tasks, finding a viable path after hitting a wall, being corrected by the user, discovering a non-trivial workflow) are extracted. Experiences are stored independently as skills — at most 20, with the least recently used automatically evicted. During conversations, trigger keywords auto-match or the AI proactively looks them up, so you never re-learn the same lesson twice.

### Memory System
Triple-tier memory: manually written persistent memories + auto-extracted key information after sessions + recent conversation context. Memories are categorized by type (fact, decision, preference) with SQLite FTS5 full-text search.

### Canvas Page Generation
Visual HTML page generation mode: AI generates code → iframe live preview → canvas annotation feedback → iterative refinement. Features WebGL gradient loading animations, multi-region parallel generation, and one-click HTML export.

### Conversation Management
All conversations are persisted in local SQLite (WAL mode) with auto-title generation. Individual messages can be liked, saved to the knowledge base, and inspected for token usage. Auto-cleanup for old sessions.

### Knowledge Saving & Statistics
Save individual messages to the knowledge base with the Favorite source type and automatic compilation. Without an available model configuration, the searchable original remains available. Saving is one-way; delete entries in the Knowledge Center. Token usage is displayed as stacked bar charts across hourly, daily, and monthly views — all data stored locally.

### Plan System
Multi-step task planning (create_plan / advance_plan) — AI can create structured execution plans and work through them step by step, ideal for complex workflows.

### Bilingual Support
Built-in Chinese and English interface with instant switching. The current language is automatically injected into the system prompt to ensure the AI responds in the correct language.
`

function AboutPage(): React.ReactElement {
  const { locale } = useTranslation()
  const content = locale === 'zh' ? productIntroMdZh : productIntroMdEn

  return (
    <CenteredPage>
      <div className="x-markdown-light" style={{ fontSize: 14, lineHeight: 1.8 }}>
        <XMarkdown content={content} />
      </div>
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #f0f0f0', textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          PulseMind v{__APP_VERSION__}
        </Text>
      </div>
    </CenteredPage>
  )
}

export default AboutPage
