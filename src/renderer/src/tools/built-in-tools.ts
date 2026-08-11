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
      'Read a file from the local filesystem. Returns content with a --- File Metadata --- header (path, size, line range). Use offset/limit for large files instead of reading the whole thing. Auto-converts PDF/DOCX/XLSX and other document formats to markdown.',
    category: 'file',
    triggers: ['read', 'open', 'cat', 'view'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to read.'
        },
        offset: {
          type: 'integer',
          description: 'Start line (1-based).'
        },
        limit: {
          type: 'integer',
          description: 'Max lines to read (default 200, hard cap 500).'
        },
        binary: {
          type: 'boolean',
          description: 'Output hex dump via xxd instead of text.'
        }
      },
      required: ['file_path']
    },
    instructions: toolInstructions.read,
    builtIn: true
  },

  // ── write ─────────────────────────────────────────────────────────
  {
    name: 'write',
    description:
      'Write content to a file on the local filesystem. Overwrites by default — set append:true to append. Content longer than 10KB is auto-split into chunks. Prefer edit for targeted changes to existing files.',
    category: 'file',
    triggers: ['write', 'save', 'create', 'output'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the target file.'
        },
        content: {
          type: 'string',
          description: 'The text content to write.'
        },
        append: {
          type: 'boolean',
          description: 'Append instead of overwrite.'
        }
      },
      required: ['file_path', 'content']
    },
    instructions: toolInstructions.write,
    builtIn: true
  },

  // ── edit ──────────────────────────────────────────────────────────
  {
    name: 'edit',
    description: 'Apply exact replacements or unified diffs to an existing file.',
    category: 'file',
    triggers: ['edit', 'change', 'replace', 'update', 'fix', 'patch', 'diff'],
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to edit.'
        },
        old_str: {
          type: 'string',
          description: '(search/replace mode) The exact text to find and replace. Must match uniquely (or set multi: true). Not needed when using diff.'
        },
        new_str: {
          type: 'string',
          description: '(search/replace mode) The replacement text. Not needed when using diff.'
        },
        multi: {
          type: 'boolean',
          description: 'Replace ALL occurrences of old_str.'
        },
        diff: {
          type: 'string',
          description: '(diff mode) Unified diff to apply. More token-efficient than search/replace. Include 1-2 context lines. See instructions for format details.'
        }
      },
      required: ['file_path']
    },
    instructions: toolInstructions.edit,
    builtIn: true
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
          description: 'Absolute path to the directory to list.'
        },
        recursive: {
          type: 'boolean',
          description: 'List recursively (fixed depth 2). To explore deeper, call list_dir again on a subdirectory.'
        },
        limit: {
          type: 'integer',
          description: 'Max entries to return. Use with offset to paginate. Omit for first 100 entries.'
        },
        offset: {
          type: 'integer',
          description: 'Entries to skip (use with limit for pagination).'
        }
      },
      required: ['dir_path']
    },
    instructions: toolInstructions.list_dir,
    builtIn: true
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
          description: 'The search query or regex pattern.'
        },
        search_dir: {
          type: 'string',
          description: 'Directory to search in.'
        },
        include: {
          type: 'string',
          description: 'File glob pattern(s) to include. Comma-separated for multiple (e.g. "*.ts" or "*.tsx,*.ts,*.js").'
        },
        exclude: {
          type: 'string',
          description: 'File glob pattern(s) to exclude. Comma-separated for multiple (e.g. "*.test.ts" or "node_modules,dist").'
        }
      },
      required: ['query']
    },
    instructions: toolInstructions.search,
    builtIn: true
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
          description: 'File name pattern (glob syntax, case-insensitive). Omit to match all files (useful with type filter).'
        },
        search_dir: {
          type: 'string',
          description: 'Directory to search in.'
        },
        max_depth: {
          type: 'integer',
          description: 'Max directory depth.'
        },
        type: {
          type: 'string',
          description: 'File type filter: "f" for files only, "d" for directories only. Omit for both.'
        },
        extra_args: {
          type: 'string',
          description: 'Additional find arguments (e.g. "-o -name \\"*.env*\\"" for OR patterns, "-type f" for file filter). Overrides pattern if more control needed.'
        }
      },
      required: []
    },
    instructions: toolInstructions.find,
    builtIn: true
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
          description: 'The question or prompt shown to the user'
        },
        choices: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'List of available options as string array, cannot be empty'
        },
        multi: {
          type: 'boolean',
          description: 'Allow multiple selections; default false for single choice',
          default: false
        }
      },
      required: ['prompt', 'choices']
    },
    instructions: toolInstructions.ask_user,
    builtIn: true
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
          description: 'The shell command to execute. Supports pipes, redirects, and chaining.'
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command.'
        },
        timeout: {
          type: 'integer',
          description: 'Idle timeout in seconds. Killed if no output for this duration.'
        },
        sudo: {
          type: 'boolean',
          description: 'Run with admin/root privileges (sudo/UAC).'
        }
      },
      required: ['command']
    },
    instructions: toolInstructions.exec,
    builtIn: true
  },

  {
    name: 'install',
    description:
      'Install a skill or register an MCP server. You MUST use the create_skill or create_mcp skill first to prepare the configuration files — do NOT call this tool directly without following those guides. Supports two modes via the "type" field: "skill" installs a skill from disk at ~/.pulsemind/skills/<name>/SKILL.md, "mcp" registers an MCP server from ~/.pulsemind/mcp/mcp-servers.json by matching the server name.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['skill', 'mcp'],
          description: '"skill" — install a skill from ~/.pulsemind/skills/<name>/SKILL.md (use create_skill first). "mcp" — register an MCP server from ~/.pulsemind/mcp/mcp-servers.json (use create_mcp first).'
        },
        name: {
          type: 'string',
          description: 'For "skill": the skill directory name under ~/.pulsemind/skills/. For "mcp": the server name (config.name) in mcp-servers.json. Refer to the create_skill or create_mcp skill for full setup instructions.'
        }
      },
      required: ['type', 'name']
    },
    instructions: toolInstructions.install,
    builtIn: true
  },

  // ── webfetch ───────────────────────────────────────────────────────
  {
    name: 'webfetch',
    description: 'Fetch a URL and return its content as text. Supports GET and POST requests.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method (GET or POST).' },
        headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs (e.g. {"Authorization": "Bearer xxx"}).' },
        body: { type: 'string', description: 'Request body for POST requests.' },
        maxLength: { type: 'integer', description: 'Maximum characters to return (default: no limit, but large responses are automatically truncated with head+tail).' },
      },
      required: ['url']
    },
    instructions: toolInstructions.webfetch,
    builtIn: true
  },

  // ── memory_search ──────────────────────────────────────────────────
  {
    name: 'memory_search',
    description: 'Search across memories, decisions, and user preferences.',
    category: 'memory',
    triggers: ['memory', 'recall', 'remember', 'search memory', 'past context', '记忆', '记得', '回忆', '上次', '之前'],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant memories.'
        },
        category: {
          type: 'string',
          description: 'Filter by category (optional).',
          enum: ['code', 'architecture', 'user_pref', 'decision', 'general']
        },
        limit: {
          type: 'integer',
          description: 'Max results to return.'
        }
      },
      required: ['query']
    },
    instructions: toolInstructions.memory_search,
    builtIn: true,
    availability: 'gated'
  },

  // ── memory_save ────────────────────────────────────────────────────
  {
    name: 'memory_save',
    description: 'Save an important fact, decision, or preference to long-term memory.',
    category: 'memory',
    triggers: ['remember', 'save', 'important', 'note this', '重要', '记一下'],
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact, decision, or preference to remember. Be specific and include context.'
        },
        type: {
          type: 'string',
          description: 'The type of memory.',
          enum: ['fact', 'decision', 'preference']
        },
        category: {
          type: 'string',
          description: 'The category of memory.',
          enum: ['code', 'architecture', 'user_pref', 'decision', 'general']
        }
      },
      required: ['content']
    },
    instructions: toolInstructions.memory_save,
    builtIn: true,
    availability: 'gated'
  },

  // ── conversation_search ────────────────────────────────
  {
    name: 'conversation_search',
    description: 'Search past conversations by keyword or ID.',
    category: 'memory',
    triggers: ['conversation', 'summary', 'past conversation', 'session history'],
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Look up a specific conversation by ID (e.g. "conv_20260430152243").'
        },
        query: {
          type: 'string',
          description: 'Keyword to search in titles, summaries, and keywords (max 20 results).'
        }
      },
      required: []
    },
    instructions: toolInstructions.conversation_search,
    builtIn: true,
    availability: 'gated'
  },

  // ── tool_result_search ────────────────────────────────────────────────
  {
    name: 'tool_result_search',
    description: 'Look up the original content of compressed tool results by tool_result_id.',
    category: 'memory',
    triggers: ['tool result', 'lookup tool result', 'find tool result', 'search tool result'],
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more tool_result_id values to look up.'
        }
      },
      required: ['ids']
    },
    instructions: toolInstructions.tool_result_search,
    builtIn: true,
    // Always available: compacted tool_results surface as [tool_result_id: xxx]
    // placeholders mid-conversation, and the model must be able to resolve them
    // without relying on user-text keyword triggers.
    availability: 'always'
  },

  // ── pick_skill ──────────────────────────────────────────────────────
  {
    name: 'pick_skill',
    description: 'Select and activate the most relevant skill by intent or name.',
    category: 'system',
    triggers: ['skill', 'pick skill', 'select skill', 'activate skill'],
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'A clear description of what the user wants to accomplish, used to select the most relevant skill. Ignored if "name" is provided.'
        },
        name: {
          type: 'string',
          description: 'The exact name of a skill to activate directly. When provided, the skill is looked up by name instead of using LLM-based intent matching.'
        }
      },
      oneOf: [
        { required: ['intent'] },
        { required: ['name'] }
      ]
    },
    instructions: toolInstructions.pick_skill,
    builtIn: true
  },

  // ── pick_tool ──────────────────────────────────────────────────────
  {
    name: 'pick_tool',
    description: 'Select and activate MCP tools by server, intent, or exact names.',
    category: 'system',
    input_schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'A clear description of what you want to accomplish, used to select the most relevant MCP tools. Ignored if "names" or "serverName" is provided.'
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact MCP tool names to activate directly. When provided, intent is ignored.'
        },
        serverName: {
          type: 'string',
          description: 'Name of an MCP server to activate all its tools. Use this to load every tool from a specific MCP server. Ignored if "names" is provided.'
        }
      },
      oneOf: [
        { required: ['intent'] },
        { required: ['names'] },
        { required: ['serverName'] }
      ]
    },
    instructions: toolInstructions.pick_tool,
    builtIn: true
  },

  // ── knowledge_search ───────────────────────────────────────────────
  {
    name: 'knowledge_search',
    description: 'Search the local knowledge base for imported files and wiki pages.',
    category: 'knowledge',
    triggers: ['knowledge', 'wiki', 'knowledge base', 'search knowledge', 'lookup knowledge', '知识', '知识库', '文档'],
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term to filter knowledge files by title and/or content (depends on mode).'
        }
      },
      required: []
    },
    instructions: toolInstructions.knowledge_search,
    builtIn: true,
    availability: 'gated'
  },

  // ── knowledge_read ─────────────────────────────────────────────────
  {
    name: 'knowledge_read',
    description: 'Read a knowledge base file or wiki page.',
    category: 'knowledge',
    triggers: ['read knowledge', 'view knowledge', 'open wiki', 'read wiki'],
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file path or wiki page name to read (e.g. "index.md" for wiki index, or a raw file path from knowledge_search results).'
        },
        type: {
          type: 'string',
          description: 'Whether to read from the wiki (compiled) or raw (source) directory.',
          enum: ['wiki', 'raw']
        }
      },
      required: ['path']
    },
    instructions: toolInstructions.knowledge_read,
    builtIn: true,
    availability: 'gated'
  },

  // ── spawn_agent ────────────────────────────────────────────────────
  {
    name: 'spawn_agent',
    description: 'Delegate a task to a sub-agent. Runs independently with isolated context.',
    category: 'system',
    triggers: ['delegate', 'subtask', 'sub-agent', 'spawn', 'background task'],
    input_schema: {
      type: 'object',
      properties: {
        subAgentId: {
          type: 'string',
          description: 'The ID of the sub-agent to use. Choose the most suitable one from the available sub-agent list (see instructions for the full list with descriptions).'
        },
        task: {
          type: 'string',
          description: 'Detailed description of the task to delegate. Be specific about what you want the sub-agent to accomplish, what context to use, and what format the results should be in.'
        }
      },
      required: ['subAgentId', 'task']
    },
    instructions: toolInstructions.spawn_agent,
    builtIn: true
  },

  // ── create_plan ──────────────────────────────────────────────────
  {
    name: 'create_plan',
    description: 'Create a step-by-step execution plan for complex multi-step tasks. You MUST call advance_plan after completing each individual step — the plan does not auto-advance.',
    category: 'system',
    triggers: ['plan', 'strategy', '步骤', '计划'],
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'A concise statement of what the plan aims to achieve.'
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of steps to accomplish the objective. Each step should be a clear, actionable description.'
        },
      },
      required: ['objective', 'steps']
    },
    instructions: toolInstructions.create_plan,
    builtIn: true
  },

  // ── advance_plan ─────────────────────────────────────────────────
  {
    name: 'advance_plan',
    description: 'MANDATORY: call after EVERY completed step to mark it done and move to the next. The plan never advances without this call — without it the plan remains stuck on the current step.',
    category: 'system',
    triggers: ['next step', 'step complete', 'done', '进度', '下一步'],
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['complete', 'fail', 'finish'],
          description: '"complete" — marks current step done and advances to next. "fail" — marks current step as failed (stay on same step). "finish" — marks entire plan complete.'
        },
        notes: {
          type: 'string',
          description: 'Optional notes about what happened in this step. Will be injected into the plan context for the LLM.'
        }
      },
      required: ['action']
    },
    instructions: toolInstructions.advance_plan,
    builtIn: true
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
          description: 'Directory to run git in (default: workspace). Must be inside a git repo.'
        }
      },
      required: []
    },
    instructions: toolInstructions.git_status,
    builtIn: true,
    availability: 'gated'
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
          description: 'Directory to run git in.'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of paths to restrict the diff to.'
        },
        staged: {
          type: 'boolean',
          description: 'If true, show only staged (index) changes.'
        },
        statOnly: {
          type: 'boolean',
          description: 'If true, show only a --stat summary instead of the full diff.'
        }
      },
      required: []
    },
    instructions: toolInstructions.git_diff,
    builtIn: true,
    availability: 'gated'
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
          description: 'Directory to run git in.'
        },
        n: {
          type: 'integer',
          description: 'Number of commits to show (default 20).'
        }
      },
      required: []
    },
    instructions: toolInstructions.git_log,
    builtIn: true,
    availability: 'gated'
  },

  // ── git_commit ────────────────────────────────────────────────────
  {
    name: 'git_commit',
    description: 'Create a commit in the git repository. Stages the given files (or the current staged changes) and commits with a Conventional Commits message.',
    category: 'git',
    triggers: ['git commit', 'commit', '提交'],
    input_schema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to run git in.'
        },
        message: {
          type: 'string',
          description: 'Commit message following Conventional Commits (feat:, fix:, refactor:, docs:, chore:).'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of paths to stage and commit. If omitted, commits the currently staged changes.'
        }
      },
      required: ['message']
    },
    instructions: toolInstructions.git_commit,
    builtIn: true,
    availability: 'gated'
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
          description: 'Directory to run git in.'
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to restore (required).'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually execute. Without it, returns a preview of what would be restored.'
        }
      },
      required: ['files']
    },
    instructions: toolInstructions.git_restore,
    builtIn: true,
    availability: 'gated'
  },
]
