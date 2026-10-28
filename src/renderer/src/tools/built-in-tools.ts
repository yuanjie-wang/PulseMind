import type { ToolDefinition } from './types'
import { toolInstructions } from './tool-instructions'

/**
 * Built-in tools compatible with Claude Code / OpenClaw tool ecosystems.
 *
 * Each tool has:
 * - A JSON Schema input_schema (used as Anthropic tool_use parameters)
 * - Markdown instructions injected into the system prompt
 */
export const BUILT_IN_TOOLS: ToolDefinition[] = [
  // ── read ──────────────────────────────────────────────────────────
  {
    name: 'read',
    description:
      'Read a file from the local filesystem. Returns content with a --- File Metadata --- header (path, size, line range); every content line carries its absolute line-number prefix ("N\\t", cat -n style) — a coordinate for referencing, never part of the file. Use offset/limit for large files instead of reading the whole thing. Auto-converts PDF/DOCX/XLSX and other document formats to markdown.',
    category: 'file',
    triggers: ['read', 'open', 'cat', 'view'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
        offset: {
          type: 'integer',
          description: 'Start line (1-based).',
        },
        limit: {
          type: 'integer',
          description: 'Max lines to read (default 500, hard cap 1000).',
        },
        binary: {
          type: 'boolean',
          description: 'Output hex dump via xxd instead of text.',
        },
      },
      required: ['file_path'],
    },
    instructions: toolInstructions.read,
    builtIn: true,
  },

  // ── write ─────────────────────────────────────────────────────────
  {
    name: 'write',
    description:
      'Write content to a file on the local filesystem. Overwrites by default — set append:true to append. Content longer than 10KB is auto-split into chunks. Prefer edit for targeted changes to existing files. ALWAYS create files with this tool instead of shell redirection/heredoc — the user\'s app auto-previews files written this way, and shell-written files bypass workspace isolation.',
    category: 'file',
    triggers: ['write', 'save', 'create', 'output'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the target file.',
        },
        content: {
          type: 'string',
          description: 'The text content to write.',
        },
        append: {
          type: 'boolean',
          description: 'Append instead of overwrite.',
        },
      },
      required: ['file_path', 'content'],
    },
    instructions: toolInstructions.write,
    builtIn: true,
  },

  // ── edit ──────────────────────────────────────────────────────────
  {
    name: 'edit',
    description:
      'Apply exact replacements, a unified diff, or an atomic multi-file git-style diff to files. Multi-file form changes several files in one all-or-nothing call.',
    category: 'file',
    triggers: ['edit', 'change', 'replace', 'update', 'fix', 'patch', 'diff'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Absolute path to the file to edit. Required for search/replace and single-file diff mode; omit it to run a multi-file diff (targets then come from the diff headers).',
        },
        old_str: {
          type: 'string',
          description: '(search/replace mode) The exact text to find and replace. Must match uniquely (or set multi: true). Not needed when using diff.',
        },
        new_str: {
          type: 'string',
          description: '(search/replace mode) The replacement text. Not needed when using diff.',
        },
        multi: {
          type: 'boolean',
          description: 'Replace ALL occurrences of old_str.',
        },
        diff: {
          type: 'string',
          description:
            '(diff mode) Unified diff to apply. More token-efficient than search/replace; include 1-2 context lines. Multi-file form: a git-style diff with one `diff --git a/<path> b/<path>` section per file (no file_path) — applied ATOMICALLY: any failed hunk rejects the whole call and `--- /dev/null` sections create new files. See instructions for format details.',
        },
      },
    },
    instructions: toolInstructions.edit,
    builtIn: true,
  },

  // ── list_dir ──────────────────────────────────────────────────────
  {
    name: 'list_dir',
    description: 'List directory contents with optional recursion.',
    category: 'file',
    triggers: ['list', 'ls', 'dir', 'directory', 'folder'],
    input_schema: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description: 'Absolute path to the directory to list.',
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively (fixed depth 2). To explore deeper, call list_dir again on a subdirectory.',
        },
        limit: {
          type: 'integer',
          description: 'Max entries to return. Use with offset to paginate. Omit for first 100 entries.',
        },
        offset: {
          type: 'integer',
          description: 'Entries to skip (use with limit for pagination).',
        },
      },
      required: ['dir_path'],
    },
    instructions: toolInstructions.list_dir,
    builtIn: true,
  },

  // ── search ────────────────────────────────────────────────────────
  {
    name: 'search',
    description: 'Search for a pattern in files using ripgrep.',
    category: 'file',
    triggers: ['search', 'find', 'grep', 'lookup', 'locate'],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query or regex pattern.',
        },
        search_dir: {
          type: 'string',
          description: 'Directory to search in.',
        },
        include: {
          type: 'string',
          description: 'File glob pattern(s) to include. Comma-separated for multiple (e.g. "*.ts" or "*.tsx,*.ts,*.js").',
        },
        exclude: {
          type: 'string',
          description: 'File glob pattern(s) to exclude. Comma-separated for multiple (e.g. "*.test.ts" or "node_modules,dist").',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'content (default): matching lines as path:line:text. files_with_matches: only the paths of files that match — the cheap way to learn WHICH files to read. count: path:N matches per file — size a pattern before reading.',
        },
        context: {
          type: 'integer',
          description: 'Lines of context before and after each match (0-5, default 0). Context lines print as path-line-text. Content mode only.',
        },
      },
      required: ['query'],
    },
    instructions: toolInstructions.search,
    builtIn: true,
  },

  // ── find ─────────────────────────────────────────────────────────
  {
    name: 'find',
    description: 'Search for files by name pattern using glob (e.g. "*.ts"). For content search, use search tool.',
    category: 'file',
    triggers: ['find', 'locate', 'glob', 'lookup file', 'search file'],
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'File name pattern (glob syntax, case-insensitive). Omit to match all files (useful with type filter).',
        },
        search_dir: {
          type: 'string',
          description: 'Directory to search in.',
        },
        max_depth: {
          type: 'integer',
          description: 'Max directory depth.',
        },
        type: {
          type: 'string',
          description: 'File type filter: "f" for files only, "d" for directories only. Omit for both.',
        },
        extra_args: {
          type: 'string',
          description:
            'Additional find arguments (e.g. "-o -name \\"*.env*\\"" for OR patterns, "-type f" for file filter). Overrides pattern if more control needed.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.find,
    builtIn: true,
  },

  // ── ask_user ──────────────────────────────────────────────────────
  {
    name: 'ask_user',
    description: 'Present fixed options for user selection. Must be used for 2+ choices.',
    category: 'interaction',
    triggers: ['choose', 'select', 'pick', 'option', 'selection'],
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The question or prompt shown to the user',
        },
        choices: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'List of available options as string array, cannot be empty',
        },
        multi: {
          type: 'boolean',
          description: 'Allow multiple selections; default false for single choice',
          default: false,
        },
      },
      required: ['prompt', 'choices'],
    },
    instructions: toolInstructions.ask_user,
    builtIn: true,
  },

  // ── exec ──────────────────────────────────────────────────────────
  {
    name: 'exec',
    description: 'Execute a shell command on the local machine.',
    category: 'system',
    triggers: ['exec', 'run', 'command', 'shell', 'terminal', 'bash', 'powershell', 'execute'],
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute. Supports pipes and chaining. Never write files via redirection/heredoc — use the write tool.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command.',
        },
        timeout: {
          type: 'integer',
          description: 'Idle timeout in seconds. Killed if no output for this duration.',
        },
        background: {
          type: 'boolean',
          description: 'Run in the background: the result returns IMMEDIATELY with an OS pid; output goes to a log you read with exec_logs(pid), and you stop the process with exec_kill(pid). Use for dev servers, watchers and anything long-lived.',
        },
        sudo: {
          type: 'boolean',
          description: 'Run with admin/root privileges (sudo/UAC).',
        },
      },
      required: ['command'],
    },
    instructions: toolInstructions.exec,
    builtIn: true,
  },

  // ── background-process channels (PLAN-coding-contract P0-3) ──
  {
    name: 'exec_logs',
    description: 'Read the output log of a background process you started (exec with background:true). Pass the pid the exec result gave you; call again later to follow progress. The log ends with "[exited code=N]" once the process has ended.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        pid: {
          type: 'integer',
          description: 'The pid returned by the background exec result.',
        },
        tail: {
          type: 'integer',
          description: 'How many bytes of the log tail to return (default 8KB, max 64KB).',
        },
      },
      required: ['pid'],
    },
    instructions: toolInstructions.exec_logs,
    builtIn: true,
  },

  {
    name: 'exec_kill',
    description: 'Stop a background process you started (exec with background:true) by its pid.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        pid: {
          type: 'integer',
          description: 'The pid returned by the background exec result.',
        },
      },
      required: ['pid'],
    },
    instructions: toolInstructions.exec_kill,
    builtIn: true,
  },

  {
    name: 'install',
    description:
      'Install a skill or register an MCP server. Skills: the ~/.pulsemind/skills/ directory is writable with the write/edit tools — revise an existing SKILL.md directly (the next pick_skill serves the new text; no re-registration needed). THIS tool registers: "skill" with "content" (the complete SKILL.md) writes, registers and enables in one step — never overwriting an existing skill; "skill" with only "name" registers and enables an already-written ~/.pulsemind/skills/<name>/SKILL.md. "mcp" with "config" (the server config object) registers and starts the server in one call — mcp-servers.json itself stays protected. Activate the create_skill or create_mcp skill first for the authoring formats.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['skill', 'mcp'],
          description:
            '"skill" — register a skill from the SKILL.md text passed as "content", or an already-written file via "name". "mcp" — register an MCP server from the config object passed as "config".',
        },
        content: {
          type: 'string',
          description:
            'type="skill" only: the COMPLETE SKILL.md — YAML frontmatter (name/description/category/triggers) plus the body. The frontmatter "name" becomes the skill\'s directory name. An existing skill is never overwritten — for revisions, edit ~/.pulsemind/skills/<name>/SKILL.md directly instead. Optional "name" must equal the frontmatter name.',
        },
        config: {
          type: 'object',
          description:
            'type="mcp" only: the server config — { name, command, args, env } for stdio, { name, url, headers } for sse / streamable-http, optional requireApproval. Optional "name" must equal config.name.',
        },
        name: {
          type: 'string',
          description:
            'For "skill" without "content": the directory name under ~/.pulsemind/skills/ whose SKILL.md should be registered and enabled (e.g. one you just wrote with the write tool). With "content": optional, must equal the frontmatter name. For "mcp": optional, must equal config.name.',
        },
      },
      required: ['type'],
    },
    instructions: toolInstructions.install,
    builtIn: true,
  },

  // ── webfetch ───────────────────────────────────────────────────────
  {
    name: 'webfetch',
    description: 'Fetch a URL and return its content as text. Supports GET and POST requests. Set raw:true for JSON/API payloads you will parse — the body comes back as-is, without the metadata header.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method (GET or POST).' },
        headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs (e.g. {"Authorization": "Bearer xxx"}).' },
        body: { type: 'string', description: 'Request body for POST requests.' },
        raw: {
          type: 'boolean',
          description: 'Return the response body exactly as received, with no `--- WebFetch ---` metadata header. Use for JSON and other API payloads you intend to parse. Default false.',
        },
        maxLength: {
          type: 'integer',
          description: 'Clip the body to this many characters; a trailing note states the original size. Default: no clip (very large results still hit the engine-wide tool-result guardrail, which truncates head+tail and saves the full text under ~/.pulsemind/tmp/trunc/).',
        },
      },
      required: ['url'],
    },
    instructions: toolInstructions.webfetch,
    builtIn: true,
  },

  // ── recall（PLAN-recall-unification，2026-10-25）──
  // 联邦检索一元化：memory_search / conversation_search / knowledge_search 三合
  // 一（用户裁定：数据源类型对模型无意义，能提供相关信息就行）。无 sources/type
  // 参数；源只出现在结果信封的标签里（后续动作说明书）。always —— 采纳率是本
  // 工具的存在理由，不做激活门。
  {
    name: 'recall',
    description: 'Search EVERYTHING local in one call — memory pages (user preferences, decisions, facts, experiences), past conversation records, and the knowledge base (compiled wiki + raw documents). Nothing is injected into your context; this is the only view. On a task-bearing turn, recall BEFORE acting.',
    category: 'memory',
    triggers: ['memory', 'recall', 'remember', 'search', 'past context', 'knowledge', 'wiki', 'history', '记忆', '记得', '回忆', '上次', '之前', '知识', '文档', '历史', '找过'],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword query across all stores (Chinese supported, 2-4 char terms work).',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return.',
        },
      },
      required: ['query'],
    },
    instructions: toolInstructions.recall,
    builtIn: true,
    availability: 'always',
  },

  // ── memory_save ────────────────────────────────────────────────────
  // Always in the toolset（user 2026-10-10，与 memory_search 同裁定）：记忆
  // 读写是常驻区的配套通道，不该等激活。triggers 留着——关键词门读每个
  // gated 工具的触发词来激活整个类目，这里仍是 tool_result_search 的中文门。
  {
    // v2（PLAN-memory-wiki）：写面 = 记忆页。title 命中既有页 → update（content
    // 必须是完整修订稿）；未命中 → create。吸收了 experience_save 的职能。
    name: 'memory_save',
    description: 'Save or update a memory page. If `title` matches an existing page it is UPDATED (content = the full revised body); otherwise a new page is created. Types: fact / decision / preference (one short sentence, ≤100 chars) or experience (long playbook).',
    category: 'memory',
    triggers: ['remember', 'save', 'important', 'note this', '重要', '记一下'],
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The page title — a unique topic name. Reusing an existing title updates that page.',
        },
        content: {
          type: 'string',
          description: 'Page body. For fact/preference: ONE sentence, at most 100 characters. For decision/experience: full structured content.',
        },
        type: {
          type: 'string',
          description: 'The page type.',
          enum: ['fact', 'decision', 'preference', 'experience'],
        },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Likely search terms for this page (optional).',
        },
      },
      required: ['title', 'content'],
    },
    instructions: toolInstructions.memory_save,
    builtIn: true,
    availability: 'always',
  },

  // ── tool_result_search ────────────────────────────────────────────────
  // 上下文类目（user 2026-10-10，随 context_compact 同迁）：压缩结果的取回
  // 是上下文治理的取回半边。availability 是 'always' 而非 gated——占位符
  // 出现在对话中段时模型必须能立即取回，不能等用户文本关键词激活
  // （2026-10-26 修正本注释：旧文说「仍 gated」与代码相悖；该工具当天还被
  // 发现从未接过执行器，模型调用落到 shell 兜底路径以 exit 0 假成功收场）。
  {
    name: 'tool_result_search',
    description: 'Look up the original content of compressed tool results by tool_result_id.',
    category: 'context',
    triggers: ['tool result', 'lookup tool result', 'find tool result', 'search tool result'],
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more tool_result_id values to look up.',
        },
      },
      required: ['ids'],
    },
    instructions: toolInstructions.tool_result_search,
    builtIn: true,
    // Always available: compacted tool_results surface as ⟨archived: xxx⟩
    // placeholders mid-conversation, and the model must be able to resolve them
    // without relying on user-text keyword triggers.
    availability: 'always',
  },

  // ── context_compact (PLAN-context-compact-tool) ──────────────────────
  {
    name: 'context_compact',
    description:
      'Manually compact the conversation context at a phase boundary you judge right (exploration finished, topic switch, before a large new stage): older context is archived into a summary injected into later requests, freeing window space. Attach a handover note (notes) to carry your progress and next steps verbatim. Refused when plenty of window remains (the refusal reports the actual headroom), when already used this turn, or while a request is streaming.',
    // 上下文类目（user 2026-10-10：压缩是上下文管理，不是记忆）。原 'memory'
    // 是计划书 D1 的「取回半边归队」推理——tool_result_search 早已在 memory，
    // 驱逐半边跟进即可省一个类目；该推理混淆了知识面（记忆：跨会话的用户
    // 知识）与上下文面（会话内窗口治理）。功能面无感：审批豁免按名字枚举
    // （execution-flow isMemoryTool）、关键词门只看 gated、schema 不携带
    // category——消费方只有设置面板的分组显示。
    category: 'context',
    input_schema: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description:
            'Focus instruction for the summarizer: what this summary must preserve for the work ahead (key decisions / file paths / open items).',
        },
        notes: {
          type: 'string',
          description:
            'Your handover note, injected verbatim into later requests (never rewritten). State current progress, next steps, and pitfalls to remember.',
        },
        free_results: {
          type: 'array',
          items: { type: 'string' },
          description:
            'tool_use ids of YOUR earlier calls whose results should be compressed to placeholders right away. Content stays retrievable via tool_result_search; results inside the last few turns are protected and will be skipped. Usable on its own.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.context_compact,
    builtIn: true,
    // Always (user ruling 2026-10-01): proactivity first — the model must SEE the
    // tool to reach for it at a semantic boundary. Precedent = tool_result_search
    // (same category, always). The `triggers` field is inert on non-gated tools,
    // so none are set; the manual below rides buildToolProtocols like every
    // other always tool's.
    availability: 'always',
  },

  // ── pick_skill ──────────────────────────────────────────────────────
  {
    name: 'pick_skill',
    description: 'Select and activate the most relevant skill — an installed skill or an experience learned from past conversations — by intent or name.',
    category: 'system',
    triggers: ['skill', 'pick skill', 'select skill', 'activate skill'],
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'A clear description of what the user wants to accomplish, used to select the most relevant skill or experience. Ignored if "name" is provided.',
        },
        name: {
          type: 'string',
          description:
            'The exact name of a skill, or the exact title (or an alias) of an experience, to activate directly. When provided, the entry is looked up by name instead of using LLM-based intent matching.',
        },
      },
      oneOf: [{ required: ['intent'] }, { required: ['name'] }],
    },
    instructions: toolInstructions.pick_skill,
    builtIn: true,
  },

  // ── pick_tool ──────────────────────────────────────────────────────
  {
    name: 'pick_tool',
    description: 'Select and activate hidden tools — MCP servers or gated built-in categories — by server, intent, or exact names. Call with NO arguments to list everything pick-able and which of it is already active.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description:
            'A clear description of what you want to accomplish, used to select the most relevant MCP tools. Ignored if "names" or "serverName" is provided.',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact MCP tool names to activate directly. When provided, intent is ignored.',
        },
        serverName: {
          type: 'string',
          description:
            'Name of an MCP server to activate all its tools. Use this to load every tool from a specific MCP server. Ignored if "names" is provided.',
        },
      },
    },
    instructions: toolInstructions.pick_tool,
    builtIn: true,
  },

  // ── office_edit (PLAN-office-editing, merged 2026-10-04) ───────────
  // One tool for all three OOXML formats: the file's extension picks the
  // service, the op vocabulary is the union below. Write-only by design —
  // the read ops (docx/pptx outline, xlsx inspect) moved to office_read.
  // The old docx_edit/xlsx_edit/pptx_edit names stay in deliverables'
  // writer sets so persisted transcripts keep counting.
  {
    name: 'office_edit',
    description: "Edit a .docx/.xlsx/.pptx file in place through structured operations — the file's extension picks the editor. Byte-faithful: untouched parts are preserved exactly. Write-only: read content and get coordinates (paragraph indexes, cell addresses, shape ids) with office_read first, then send edits. Batches are atomic — any failed op writes nothing.",
    category: 'file',
    triggers: ['edit docx', 'edit word', '修改 word', '编辑文档', 'edit xlsx', 'edit excel', '修改 excel', '编辑表格', 'edit ppt', '修改 ppt', '编辑幻灯片'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the .docx/.xlsx/.pptx file (absolute or workspace-relative).' },
        ops: {
          type: 'array',
          description: 'Write ops applied in order; indexes/addresses come from office_read and refer to the CURRENT state. replace_text/find match the VISIBLE text (crosses style runs automatically); deleted-revision text is never matched. docx ops: replace_text / insert_paragraph / delete_paragraph / set_paragraph_style / format_text / insert_image / insert_table_row / delete_table_row. xlsx ops: set_cell / find_replace / add_row / set_style / set_column_width / freeze_panes. pptx ops: replace_text / set_shape_text / format_text / set_shape_fill / set_slide_background / set_shape_geometry. See the Usage Protocols for each op\'s parameters and refusals.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace_text', 'insert_paragraph', 'delete_paragraph', 'set_paragraph_style', 'format_text', 'insert_image', 'insert_table_row', 'delete_table_row', 'set_cell', 'find_replace', 'add_row', 'set_style', 'set_column_width', 'freeze_panes', 'set_shape_text', 'set_shape_fill', 'set_slide_background', 'set_shape_geometry'] },
              find: { type: 'string' }, replace: { type: 'string' },
              expected_count: { type: 'number', description: 'How many hits the op must see (default 1) — a mismatch refuses the batch.' },
              paragraph: { type: 'number', description: 'docx: 1-based paragraph index (insert/delete/style target; replace_text/format_text scope).' },
              slide: { type: 'number', description: 'pptx: 1-based slide number in presentation order (default 1 for text ops).' },
              shape_id: { type: 'string', description: 'pptx: the p:cNvPr id from office_read (table cells use cell:r:c).' },
              sheet: { type: 'string', description: 'xlsx: sheet name (defaults to first).' },
              cell: { type: 'string', description: 'xlsx set_cell/freeze_panes: e.g. "B3".' },
              track_changes: { type: 'boolean', description: 'docx replace_text: wrap replacement in <w:del>/<w:ins> revision marks (Word/WPS shows as tracked changes). Default false (direct replacement).' },
              position: { type: 'string', enum: ['before', 'after'] },
              text: { type: 'string', description: 'insert_paragraph: the paragraph text; pptx set_shape_text: the full new text, one paragraph per line.' },
              style: { type: 'string', description: 'docx set_paragraph_style / insert_paragraph: style name (e.g. "Heading1").' },
              bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' },
              strike: { type: 'boolean', description: 'pptx format_text only.' },
              color: { type: 'string', description: 'format_text: run colour; set_shape_fill: shape fill. 6-hex RRGGBB, or the literal none.' },
              font_size: { type: 'number', description: 'format_text only: size in points.' },
              font: { type: 'string', description: 'pptx format_text only: font family name (Latin and East-Asian faces).' },
              value: { type: ['string', 'number', 'boolean', 'null'], description: 'xlsx set_cell: the cell value (use formula instead for computed cells).' },
              formula: { type: 'string', description: 'xlsx set_cell: the formula (with or without leading =).' },
              number_format: { type: 'string', description: 'xlsx set_cell: e.g. "0.00%", "yyyy-mm-dd".' },
              include_formulas: { type: 'boolean', description: 'xlsx find_replace: also replace inside formula cells\' cached RESULTS (the expression itself is never rewritten).' },
              after_row: { type: 'number', description: 'xlsx add_row: 0-based row index after which to insert; existing rows shift down.' },
              values: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: 'xlsx add_row: cell values for the new row.' },
              cells: { type: 'string', description: 'xlsx set_style: "B3" or "A1:C10".' },
              fill: { type: 'string', description: 'xlsx set_style: 6-digit RRGGBB without #.' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              wrap_text: { type: 'boolean' },
              columns: { type: 'string', description: 'xlsx set_column_width: "A" or "A:C".' },
              width: { type: 'number', description: 'xlsx set_column_width: column width.' },
              image: { type: 'string', description: 'docx insert_image: a WORKSPACE image path (png/jpg/jpeg/gif; http(s)/data: are not embedded).' },
              width_px: { type: 'number' }, height_px: { type: 'number' },
              table: { type: 'number', description: 'docx insert_table_row/delete_table_row: body-level table index.' },
              row: { type: 'number', description: 'docx delete_table_row: row index.' },
              line_color: { type: 'string', description: 'pptx set_shape_fill only: outline colour (6-hex RRGGBB).' },
              x: { type: 'number', description: 'pptx set_shape_geometry: INCHES from the left edge.' },
              y: { type: 'number', description: 'pptx set_shape_geometry: inches from the top.' },
              w: { type: 'number', description: 'pptx set_shape_geometry: width in inches.' },
              h: { type: 'number', description: 'pptx set_shape_geometry: height in inches.' },
            },
          },
        },
      },
      required: ['file_path', 'ops'],
    },
    instructions: toolInstructions.office_edit,
    builtIn: true,
    availability: 'gated',
  },
  // ── office_inspect (PLAN-office-editing §P1) ─────────────────────
  {
    name: 'office_inspect',
    description: 'Edit-time triage for an Office file (.docx/.xlsx/.pptx): structural inventory (paragraph/sheet/slide list with text previews, text budget, formulas, charts, images) — NOT a full-content reader. To read or summarize the file, use `read` (auto-converts to markdown). Read-only — no modification.',
    category: 'file',
    triggers: ['inspect office', '检查文档', '盘点文档', 'office 清单'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the Office file (absolute or workspace-relative).' },
      },
      required: ['file_path'],
    },
    instructions: toolInstructions.office_inspect,
    builtIn: true,
    availability: 'gated',
  },
  // ── office_read (PLAN-office-read) ───────────────────────────────
  {
    name: 'office_read',
    description: "Read .docx/.xlsx/.pptx content in the file's own address space: docx paragraphs with FULL text + style + index (and table cell text), xlsx cell values by sheet/range (formulas shown as =expression → result), pptx shapes with shape ids and full text. The read to use before editing — `read` gives reflowed markdown for humans; office_read gives the exact indices/coordinates that office_edit consumes. Paged; the result states the next offset. Large files: start with outline: true (docx heading paragraphs / pptx slide titles), then page into the section you actually need.",
    category: 'file',
    triggers: ['read docx', 'read xlsx', 'read pptx', '读取文档', '读表格', '读取 office'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the .docx/.xlsx/.pptx file (absolute or workspace-relative).' },
        offset: { type: 'number', description: 'docx: 1-based first paragraph of the page; xlsx: 1-based first row. The previous result states the next offset.' },
        limit: { type: 'number', description: 'docx: paragraphs per page (default 40, max 200); xlsx: rows per page (default 50, max 500).' },
        tables: { type: 'boolean', description: 'docx only: also return body-level tables with per-cell text (rows "R1: c0 | c1 | ...").' },
        sheet: { type: 'string', description: 'xlsx only: sheet name. Omit it to get the sheet inventory (names + sizes) first.' },
        range: { type: 'string', description: 'xlsx only: explicit range "A1:J50" or single cell "B3" (overrides offset/limit).' },
        slide: { type: 'number', description: 'pptx only: 1-based slide in presentation order; omit to read every slide.' },
        outline: { type: 'boolean', description: 'docx/pptx only: heading outline instead of content — docx heading paragraphs (same indexes the editor consumes), pptx per-slide titles. Read this first on large files, then page into the section you need.' },
      },
      required: ['file_path'],
    },
    instructions: toolInstructions.office_read,
    builtIn: true,
    availability: 'gated',
  },

  // ── office_search (2026-10-12) ─────────────────────────────────────
  {
    name: 'office_search',
    description: "Content search inside a .docx/.xlsx/.pptx WITHOUT reading it whole: docx hits are paragraph indexes + snippets (the same index space office_read pages and office_edit edits), xlsx hits are cell addresses + the hit row's leading cells, pptx hits are slide + shape id. How you find key rows/columns in a big sheet or locate a section in a long document — read only the hits afterwards with office_read.",
    category: 'file',
    triggers: ['search office', '搜索文档', '查找表格', 'office 搜索', '定位段落', '找单元格'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the .docx/.xlsx/.pptx file (absolute or workspace-relative).' },
        query: { type: 'string', description: 'Substring (case-insensitive by default); a regular expression when regex is true.' },
        regex: { type: 'boolean', description: 'Interpret query as a regular expression.' },
        case_sensitive: { type: 'boolean', description: 'Keep case sensitivity (default insensitive).' },
        sheet: { type: 'string', description: 'xlsx only: sheet name; omit to scan every sheet.' },
        slide: { type: 'number', description: 'pptx only: 1-based slide; omit to scan every slide.' },
      },
      required: ['file_path', 'query'],
    },
    instructions: toolInstructions.office_search,
    builtIn: true,
    availability: 'gated',
  },
  // ── export_document (PLAN-office-export) ───────────────────────────
  {
    name: 'export_document',
    description: 'Export content as a real deliverable file: .docx (Word, from markdown), .xlsx (Excel, one sheet per `## ` heading), .csv, .pptx (PowerPoint slides — ALWAYS via the HTML design route `htmlPath`: align style with the user first, then tokens.css + deck.html + convert; a markdown outline via `content` is only a plain-text fallback), or .pdf (converted from docx — inline markdown, or sourcePath pointing at an existing .docx). For ANY make-a-PPT request use format pptx — never shell out to python-pptx. Give inline `content`, a workspace `htmlPath` (pptx design route), or a workspace `sourcePath` — exactly one. The file lands in the conversation workspace and opens in the preview pane.',
    category: 'file',
    triggers: ['export', '导出', '生成 excel', '生成 word', '生成 ppt', '生成 pdf', '转成表格', '转成文档', '转成 pdf'],
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['docx', 'xlsx', 'csv', 'pptx', 'pdf'], description: 'Target format.' },
        content: { type: 'string', description: 'Inline source: full markdown for docx/pptx/pdf (docx/pdf may open with a `---` frontmatter block for the document-level design: cover title/author/date, toc, header/footer/page numbers, first-line indent, accent theme — key table in office skill references/docx.md; charts ride ```chart fences in the same data-chart JSON dialect, embedded as images); a markdown table (or `## Sheet` sections) or CSV data for xlsx/csv. Soft cap 100KB — larger sources go through sourcePath.' },
        htmlPath: { type: 'string', description: '(pptx only) 设计路线：工作区 deck.html 的路径（与 content/sourcePath 互斥）。从零做 PPT 唯一生成路线——流程：①先与用户对齐风格（给 1–3 个方向：主色/明暗/字体/气质，确认后才动手，不跳过）→ ②write tokens.css（14 个主题变量：7 色 + font-zh/latin/mono + 字号阶 fs-cover/title/body/note，落定即锁）→ ③write deck.html（每页一个 960×540 的 .slide，受限 profile；font-size 引用 var(--pm-fs-*)，font-family 只许 var(--pm-font-*)）→ ④传 htmlPath 转换。图表用 <div data-chart=\'{"type":…}\'> 标注（引擎画成原生可编辑形状），禁 @font-face/渐变/网络资源。profile 全文见 office 技能 references/pptx.md 设计路线节。' },
        sourcePath: { type: 'string', description: 'Path to an existing workspace file to convert instead of inline content: .md/.csv for the generators, .docx for format pdf.' },
        fontSize: { type: 'number', description: '(docx/pdf only) 正文基准字号，单位磅，6–72 可带 0.5（10.5=五号、12=小四、16=三号）——标题与代码块按比例缩放。只调局部字号：先导出，再用 office_edit 的 format_text 改。' },
        file_path: { type: 'string', description: 'Relative target path (default: export-<timestamp>.<format> in the workspace root). Existing files are never overwritten — a -2 suffix is added.' },
      },
      required: ['format'],
    },
    instructions: toolInstructions.export_document,
    builtIn: true,
    availability: 'gated',
  },


  // ── spawn_agent ────────────────────────────────────────────────────
  {
    name: 'spawn_agent',
    description: 'Delegate a task to a sub-agent. Runs independently with isolated context and the same tools as this session. When a plan is active, ALWAYS pass planNode so the delegation links to the plan node it implements.',
    category: 'system',
    triggers: ['delegate', 'subtask', 'sub-agent', 'spawn', 'background task'],
    input_schema: {
      type: 'object',
      properties: {
        subAgentId: {
          type: 'string',
          description:
            'Optional. ID of the expert (from the available expert list) the sub-agent should work as. Omit to delegate to a general-purpose sub-agent.',
        },
        task: {
          type: 'string',
          description:
            'Detailed description of the task to delegate. Be specific about what you want the sub-agent to accomplish, what context to use, and what format the results should be in.',
        },
        planNode: {
          type: 'string',
          description:
            'The plan node this task implements: its 1-based number ("2") or id ("n2"). Pass it whenever the task executes a node of the active plan — only a READY node (pending, all dependencies completed) and never one with a live attempt is accepted. The node settles automatically when the sub-agent delivers; you are consulted only if it fails.',
        },
        preset: {
          type: 'string',
          enum: ['explore'],
          description:
            "Optional. 'explore' runs this delegation as READ-ONLY reconnaissance: the sub-agent's toolset is restricted to search/find/read/list_dir/office_read/recall and it reports a path:line map (entry points, key facts, gaps) instead of editing anything. Use it to map an unfamiliar area cheaply before planning or coding. Cannot be combined with planNode.",
        },
        agentId: {
          type: 'string',
          description:
            "Optional. FOLLOW-UP channel: a previous Sub-Agent Result's agentId (its sub_xxx conversation id). Sends task as a new message to THAT agent — it wakes with its full prior context, so follow-up questions and iterations cost no re-discovery. Omit to spawn a fresh agent. The registry keeps the most recent completed agents per session. Cannot be combined with subAgentId / preset / planNode.",
        },
      },
      required: ['task'],
    },
    instructions: toolInstructions.spawn_agent,
    builtIn: true,
  },

  // ── create_plan ──────────────────────────────────────────────────
  {
    name: 'create_plan',
    description:
      'Create an execution DAG for complex multi-step tasks that will be DELEGATED (to experts or parallel sub-agents via spawn_agent): independent nodes run in PARALLEL, nodes with depends_on wait for their prerequisites. Array order never implies order — a step without depends_on starts immediately, so dependent steps MUST name their prerequisites. Once created, the scheduler runs the plan: READY nodes dispatch automatically, each delivery settles automatically. You are consulted at exactly two points — a node FAILED (decide: re-dispatch to retry, or advance_plan action="fail"/"skip"), and the plan completing (write the final answer for the user). For tracking work you execute YOURSELF (no delegation, no parallel sub-agents), use todo_write instead.',
    category: 'system',
    triggers: ['plan', 'strategy', '步骤', '计划'],
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'A concise statement of what the plan aims to achieve.',
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Clear, actionable description of this node.',
              },
              depends_on: {
                type: 'array',
                items: { type: 'integer' },
                description: "1-based indexes of nodes that must finish before this one can start (e.g. [1, 3]). Nodes WITHOUT depends_on all start immediately, in parallel — array order never sequences them. If this node consumes another node's output, list that node here.",
              },
              assignee: {
                type: 'string',
                description: 'Expert id (from the capability center) to delegate this node to via spawn_agent. Omit for a general sub-agent.',
              },
              report_spec: {
                type: 'string',
                description: 'Optional extra report-format requirements for this node, injected on top of the standard report skeleton (状态/结论/关键数据/产物清单) its sub-agent must write to the plan exchange area. Use it when downstream nodes need a specific structure or fields.',
              },
            },
            required: ['description'],
          },
          description: 'The plan nodes. Array order is preserved for numbering (node 1..N referenced by depends_on and advance_plan) — it does NOT imply execution order. A plain string item is also accepted and chains to the previous step.',
        },
      },
      required: ['objective', 'steps'],
    },
    instructions: toolInstructions.create_plan,
    builtIn: true,
  },

  // ── advance_plan ─────────────────────────────────────────────────
  {
    name: 'advance_plan',
    description:
      'The plan\'s decision tool — the scheduler settles successful deliveries and dispatches READY nodes on its own, so do NOT report those. Use it when a node FAILED (action="fail" or "skip"; re-dispatching it yourself retries it), to correct a status by hand, or action="finish" to close the plan early. The final answer after completion is written as your message, not via this tool.',
    category: 'system',
    triggers: ['next step', 'step complete', 'done', '进度', '下一步'],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['complete', 'fail', 'skip', 'finish'],
          description:
            '"complete" — the node is done (completing a failed node = retry). "fail" — the node failed; its dependents block until retried or skipped. "skip" — abandon the node. "finish" — force-complete everything and close the plan.',
        },
        node: {
          type: 'string',
          description: 'Which node: its 1-based number ("2") or id ("n2"). Required unless exactly one node is ready.',
        },
        notes: {
          type: 'string',
          description: 'Optional one-line outcome. Stored on the node and shown in the plan panel.',
        },
      },
      required: ['action'],
    },
    instructions: toolInstructions.advance_plan,
    builtIn: true,
  },

  // ── todo_write（direct-mode plan = todo list）──────────────────────
  // The self-execution channel: the plan system's direct mode carries a flat
  // mutable list the main agent works through itself. Deliberately a SEPARATE
  // tool from create_plan (never a mode param): weak models route by tool
  // NAME, and the two contracts must not blur — create_plan always delegates,
  // todo_write never spawns anything.
  {
    name: 'todo_write',
    description:
      'Maintain a progress checklist for multi-step work you execute YOURSELF (no experts, no sub-agents — delegate via create_plan instead). Send the FULL list every time; keep exactly ONE step in_progress; mark steps waiting on something outside your control as blocked; update immediately after each step settles. Optional for trivial tasks (1-2 steps).',
    category: 'system',
    triggers: ['todo', '清单', '待办', 'progress', 'checklist', '步骤', '任务列表'],
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'What the list as a whole aims to achieve; required on the first call.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The entry\'s number ("n2" — every snapshot row shows it). REQUIRED to update an existing entry: reword it in place, change its status, or revive a retired one. Omit to append a NEW entry.',
              },
              description: {
                type: 'string',
                description: 'One actionable step. When the item carries an id, this wording replaces the entry\'s old one.',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'blocked'],
                description: '"in_progress" — the one step you are on now; "completed" — finished; "blocked" — waiting on something outside your control; omit for not started.',
              },
              note: {
                type: 'string',
                description: 'One-line context: what a blocked step waits on, a key result, a pointer.',
              },
            },
            required: ['description'],
          },
          description: 'The complete list, in the order you want it tracked.',
        },
      },
      required: ['items'],
    },
    instructions: toolInstructions.todo_write,
    builtIn: true,
  },

  // ── git_status ────────────────────────────────────────────────────
  {
    name: 'git_status',
    description: 'Check the current state of a git repository: branch, ahead/behind, staged/unstaged/untracked files, and conflicts.',
    category: 'git',
    triggers: ['git', 'status', 'branch', 'checkout', 'merge', 'rebase', 'stash', 'push', 'pull', '仓库', '分支', '合并'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in (default: workspace). Must be inside a git repo.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.git_status,
    builtIn: true,
    availability: 'gated',
  },

  // ── git_diff ──────────────────────────────────────────────────────
  {
    name: 'git_diff',
    description: 'Show the diff of a git repository — staged, unstaged, or both — with optional path filters and stat-only mode.',
    category: 'git',
    triggers: ['git diff', 'diff', 'changes'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of paths to restrict the diff to.',
        },
        staged: {
          type: 'boolean',
          description: 'If true, show only staged (index) changes.',
        },
        statOnly: {
          type: 'boolean',
          description: 'If true, show only a --stat summary instead of the full diff.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.git_diff,
    builtIn: true,
    availability: 'gated',
  },

  // ── git_log ───────────────────────────────────────────────────────
  {
    name: 'git_log',
    description: 'Show recent commit history, one line per commit (short hash + subject).',
    category: 'git',
    triggers: ['git log', 'log', 'history', 'commit history', '提交历史'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in.',
        },
        n: {
          type: 'integer',
          description: 'Number of commits to show (default 20).',
        },
      },
      required: [],
    },
    instructions: toolInstructions.git_log,
    builtIn: true,
    availability: 'gated',
  },

  // ── git_commit ────────────────────────────────────────────────────
  {
    name: 'git_commit',
    description:
      'Create a commit in the git repository. Stages the given files (or the current staged changes) and commits with a Conventional Commits message.',
    category: 'git',
    triggers: ['git commit', 'commit', '提交'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in.',
        },
        message: {
          type: 'string',
          description: 'Commit message following Conventional Commits (feat:, fix:, refactor:, docs:, chore:).',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of paths to stage and commit. If omitted, commits the currently staged changes.',
        },
      },
      required: ['message'],
    },
    instructions: toolInstructions.git_commit,
    builtIn: true,
    availability: 'gated',
  },

  // ── git_restore ───────────────────────────────────────────────────
  {
    name: 'git_restore',
    description: 'Revert tracked files back to their state at HEAD. By default returns a preview; pass confirm: true to execute.',
    category: 'git',
    triggers: ['git restore', 'restore', 'revert', 'discard', '回滚', '撤销修改'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to restore (required).',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually execute. Without it, returns a preview of what would be restored.',
        },
      },
      required: ['files'],
    },
    instructions: toolInstructions.git_restore,
    builtIn: true,
    availability: 'gated',
  },

  // The page_* family used to live in this array; it is extension-only now
  // (user ruling 2026-09-20: 「页面系列工具是仅给插件用的，不用在这里管理」) and
  // is exported separately as PAGE_BUILT_IN_TOOLS at the foot of this file —
  // the desktop registry neither lists it in the capability center nor carries
  // it in a desktop toolset.

  // ── browser (Browser Use A-M1) ─────────────────────────────────────
  // One tool for the whole browser capability: `code` runs against the
  // host-side facade (agent.browsers). The model bootstraps by reading the
  // returned documentation() and this tool's slim `instructions` pointer,
  // never by guessing member names.
  // MANUAL AS SKILL (2026-10-26, user: 系统提示词瘦身 — supersedes the
  // half-applied 2026-10-25 "gate it" sketch): the 5.4K manual was the single
  // largest non-office protocol and rode EVERY conversation via
  // buildToolProtocols. It now lives in the `browser` BUILT_IN_SKILL
  // (skills/built-in/browser.ts), loaded on demand via pick_skill; the slim
  // instructions pointer and the tool description both route there. The tool
  // itself stays always-on — the schema is ~0.7K, and hiding it behind a gate
  // would add a pick_tool round trip before the first browser call for no
  // meaningful floor saving. The settings toggle still removes it outright.
  {
    name: 'browser',
    description:
      'Drive a real web browser: open pages, read AI/ARIA snapshots, click/type/fill via locators, take screenshots and run page JS. Everything happens inside one `code` param (JS): observe → decide → act within a single call. Locate elements ONLY from domSnapshot() facts. Full manual: pick_skill(name=\'browser\') — load it before the first browser call of a session. Self-check: omit `code` to dump the live capability manifest of the sandbox.',
    category: 'browser',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JS to run against `agent.browsers` (tabs, domSnapshot, playwright ops, screenshots via emitImage). Fresh scope per call — rebind tabs every call. Omit or empty: returns the live capability manifest of the sandbox instead of running code.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Wall-clock budget for this call (default 60000, max 300000).',
        },
      },
    },
    instructions: toolInstructions.browser,
    builtIn: true,
  },
]

// ── page_* (browser extension, PLAN-browser-extension M2.2) ───────────
// These act on the tab the user is LOOKING AT — real login state, real
// session — through the extension's content script. Deliberately a separate
// family from `browser` (decision D2): that one drives its own Playwright
// browser with no user session, and the two answer different questions.
//
// NOT registered in the desktop tool registry (2026-09-20 ruling): the
// capability center has nothing to toggle and a desktop session never carries
// them. `collectEnabledTools` (tool-collection.ts) is the ONE door they enter
// a toolset through, and it opens only while the session's browser-extension
// client is bound (`opts.hostedAvailable`) — "the model must not see browser
// tools while the extension is offline".
export const PAGE_BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: 'page_get_content',
    description:
      'Read the current page as compact text with [index] markers on interactive elements. Call this FIRST. Indices are stable while the page lives — you do not need to re-read before acting on an index you already hold. Follow-up reads can pass delta:true to return only what changed.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        viewportExpansion: {
          type: 'integer',
          description:
            'Extra pixels around the viewport to include (default 0). Set -1 to analyze the whole page instead of just the visible part.',
        },
        delta: {
          type: 'boolean',
          description:
            'Return only the changes since the previous read (added/changed/removed elements, new text); unchanged elements keep their valid indices. Falls back to the full view on the first call, after navigation, or when the changes are too large.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.page_get_content,
    builtIn: true,
  },
  {
    name: 'page_scroll',
    description:
      'Scroll the page or a scrollable container. Content far down a long page does not appear in page_get_content until you scroll to it.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        down: { type: 'boolean', description: 'Scroll down (default true). Set false to scroll up.' },
        pages: { type: 'number', description: 'How many viewport heights to scroll (default 1).' },
        pixels: { type: 'number', description: 'Exact pixel distance; overrides `pages` when set.' },
        index: {
          type: 'integer',
          description: 'Scroll this container instead of the window. Index from the latest page_get_content.',
        },
      },
      required: [],
    },
    instructions: toolInstructions.page_scroll,
    builtIn: true,
  },
  {
    name: 'page_wait',
    description: 'Wait for asynchronous rendering to finish before reading the page again.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: 'Seconds to wait, 1–10 (default 2).' },
      },
      required: ['seconds'],
    },
    instructions: toolInstructions.page_wait,
    builtIn: true,
  },
  {
    name: 'page_click',
    description: 'Click an element on the current page, by its index from the latest page_get_content.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Element index from the latest page_get_content.' },
      },
      required: ['index'],
    },
    instructions: toolInstructions.page_click,
    builtIn: true,
  },
  {
    name: 'page_input',
    description: 'Type text into an input or textarea on the current page. Replaces the existing value.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Element index from the latest page_get_content.' },
        text: { type: 'string', description: 'The text to enter. Replaces whatever is in the field.' },
      },
      required: ['index', 'text'],
    },
    instructions: toolInstructions.page_input,
    builtIn: true,
  },
  {
    name: 'page_select',
    description: 'Choose an option in a dropdown on the current page.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: 'Element index of the <select> from the latest page_get_content.' },
        option: { type: 'string', description: 'Option to select, matched against its value, text or label.' },
      },
      required: ['index', 'option'],
    },
    instructions: toolInstructions.page_select,
    builtIn: true,
  },
  {
    name: 'page_back',
    description: 'Go back to the previous page in this tab.',
    category: 'page',
    input_schema: { type: 'object', properties: {}, required: [] },
    instructions: toolInstructions.page_back,
    builtIn: true,
  },
  {
    name: 'page_execute_js',
    description:
      'Run JavaScript in the current page and get the result back — the escape hatch for what the other page tools cannot express.',
    category: 'page',
    input_schema: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description:
            'Function body or arrow function, e.g. "return document.title" or "() => document.querySelectorAll(\'a\').length". May await. `args` holds the values passed in `args`.',
        },
        args: { type: 'object', description: 'Values exposed to the script as `args`.' },
      },
      required: ['script'],
    },
    instructions: toolInstructions.page_execute_js,
    builtIn: true,
  },
]

// ── create_sub_plan（PLAN-plan-split v2 R1/R5/R6）────────────────────────
// Sub-agent-ONLY: the tool writes the PARENT plan, so it exists in a spawned
// engine's toolset alone, and only for spawns of SPLITTABLE plan nodes
// (`opts.spawnPlanSplit` — the same opt carries the bridge constants the
// executor needs). Like PAGE_BUILT_IN_TOOLS, collectEnabledTools is its one
// door into a toolset; never registered in the desktop registry.
export const SUB_PLAN_BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: 'create_sub_plan',
    description:
      'Split YOUR node\'s remaining work back into the parent plan when it clearly exceeds one sub-agent — many independent sub-parts, far too long-running, or more output than one session can produce. Call it the moment you know: before starting, or mid-way when the remainder has outgrown you — never after finishing your scope. The parent\'s scheduler dispatches the new nodes once your node settles; they are NOT yours to execute.',
    category: 'system',
    triggers: ['split', 'too big', '拆分', '任务太重'],
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'One line: why one sub-agent cannot do this (or the remainder of it).',
        },
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Self-contained sub-task description — its reader sees only this text plus its dependencies\' outputs.',
              },
              depends_on: {
                type: 'array',
                items: { type: 'integer' },
                description: '1-based indexes of EARLIER subtasks in this list whose output this one consumes. Omit for independent subtasks; forward references are rejected.',
              },
              report_spec: {
                type: 'string',
                description: 'Optional extra report-format requirements for this subtask, injected on top of the standard report skeleton it must write to the plan exchange area.',
              },
            },
            required: ['description'],
          },
          description: '2–5 sub-tasks, in list order. Array order does not sequence them — without depends_on they run in parallel.',
        },
      },
      required: ['subtasks'],
    },
    instructions: toolInstructions.create_sub_plan,
    builtIn: true,
  },
]

// ── 子代理工具边界（PLAN-plan-split v2 R2，用户裁定 2026-09-29）──────────
// A spawned sub-agent plans nothing, settles nothing and delegates nothing:
// these three are REMOVED from every spawned toolset. This supersedes the
// PLAN-plan-scheduler S11 premise (「子代理内建图维持模型驱动」assumed the
// tools existed); the scheduler gate and the nested-spawn slot guard stay as
// defense in depth. The one legitimate growth channel left is
// create_sub_plan — which writes the PARENT plan through a narrow bridge,
// where the structure is visible, scheduled and bounded.
// todo_write left the list 2026-10-26 (user: 允许子代理用todo_write)：子代理
// 可以维护自己的直接清单（execTodoWrite 只动引擎自己的 PlanManager，父子
// 各一份互不可见），建图/结算/派生的边界不变。
export const SUB_AGENT_DENY_TOOLS = ['create_plan', 'advance_plan', 'spawn_agent']
