/**
 * Tool instructions — Markdown content injected into the system prompt
 * for each built-in tool. Extracted from built-in-tools.ts to decouple
 * definition from instruction content.
 */
export const toolInstructions: Record<string, string> = {
  read: `## read

Read a file from the local filesystem. Returns the file contents as text with a metadata header.

### Parameters
- **file_path** (required) — Absolute path to the file
- **offset** — Line number to start reading from (1-based, default 1)
- **limit** — Max lines to read (default 200, hard cap 500)
- **binary** — If true, returns hex dump via xxd (default false)

### Output Format
\`\`\`
--- File Metadata ---
  Path: <path>
  Size: <human-readable size> (<total lines> lines)
  Range: lines <start>-<end>
  Note: <conversion info for non-text files> (optional)
--- End File Metadata ---

<file content from offset to offset+limit>
\`\`\`

The metadata section (between \`--- File Metadata ---\` and \`--- End File Metadata ---\`) tells you the file path, total size, and the line range being returned. The actual file content follows after \`--- End File Metadata ---\`.

### Guidelines
- Use \`offset\` and \`limit\` for large files instead of reading the whole thing
- For supported document formats (PDF, DOCX, XLSX, etc.), the tool auto-converts to markdown. The header will include a \`Note:\` explaining this and the path to the full conversion file
- If you need to search before reading, use the \`search\` tool first`,

  write: `## write

Write or append content to a file on the local filesystem.

### Parameters
- **file_path** (required) — Absolute path to the target file
- **content** (required) — The text content to write. Automatically split into chunks (max 5KB per write)
- **append** — If true, append instead of overwrite (default false)

### Guidelines
- This will overwrite the file by default — use append: true if you want to add content
- Prefer using \`edit\` for targeted changes to existing files
- Directories in the path must already exist
- Keep the **content** parameter under 5KB if possible to avoid truncation during streaming. For larger outputs, use multiple consecutive write calls.
- **Large content handling**: Content longer than 10KB will be automatically split and written in multiple 10KB chunks to avoid write limits`,

  edit: `## edit

Perform exact string replacements or apply unified diffs to an existing file.

### When to use which mode

| Situation | Mode | Why |
|-----------|------|-----|
| Changing a few lines in a small file (< 100 lines) | **search/replace** | Simpler, no need to compute line numbers |
| Changing 1-2 lines in any file | **search/replace** | old_str is short and unique |
| Changing many scattered lines in a large file | **diff** | Only send changed hunks, not the full old_str |
| Multiple edits in one tool call | **diff** | One diff can contain multiple hunks |
| Deleting several lines | **diff** | More natural than matching exact deletion text |
| Inserting new blocks mid-file | **diff** | Use @@ -start,0 +start,count @@ for pure insertion |

### Parameters
- **file_path** (required) — Absolute path to the file to edit
- **old_str** + **new_str** — Search/replace mode (default): find exact text and replace it
- **multi** — In search/replace mode, replace ALL occurrences (default: replace first only)
- **diff** — Diff mode: apply a unified diff string

### Search/replace mode
- \`old_str\` must match exactly, including whitespace and indentation
- Read the file first with \`read\` to get the exact text to replace
- If \`old_str\` is not found, the operation fails
- For deleting text, use an empty \`new_str\`

### Diff mode
- Use unified diff format with hunk headers and context lines
- Include 1-2 context lines around each change for reliable matching
- Multiple hunks are supported in one diff
- Hunks are validated against file content before applying`,

  list_dir: `## list_dir

List the contents of a directory on the local filesystem.

### Parameters
- **dir_path** (required) — Absolute path to the directory
- **recursive** — If true, list recursively (default false). Recursion is fixed at depth 2.
- **limit** — Max entries to return. Use with \`offset\` to paginate. Omit for first 100 entries.
- **offset** — Number of entries to skip (default 0). Increase by \`limit\` to get the next page.

### Pagination
- Pass \`limit\` (e.g., 100) and \`offset\` (e.g., 0) together to paginate through large directories
- If the result count equals \`limit\`, there may be more entries — call again with \`offset\` increased by \`limit\`
- If the result count is less than \`limit\`, you have reached the end

### Guidelines
- Use \`list_dir\` to explore project structure before reading files
- Recursive listings cover exactly 2 levels. To explore deeper, call \`list_dir\` again on the target subdirectory — walk down one level at a time
- Hidden files/directories (starting with .) are excluded from recursive listings
- Non-recursive listings include hidden files (up to the first 100 entries)

### Examples
- \`list_dir(dir_path: "/project/src")\` — first 100 entries of the directory
- \`list_dir(dir_path: "/project", recursive: true)\` — first 100 entries spanning 2 levels
- \`list_dir(dir_path: "/project/src/components", recursive: true)\` — drill into a subdirectory to reach deeper levels
- \`list_dir(dir_path: "/project", limit: 100, offset: 200)\` — page 3 of non-recursive listing (entries 201–300)`,

  search: `## search

Search for a pattern across files using ripgrep (rg).

### Parameters
- **query** (required) — Search query or regex pattern
- **search_dir** — Directory to search in (defaults to cwd)
- **include** — File glob to include (e.g. "*.ts")
- **exclude** — File glob to exclude (e.g. "node_modules")

### Guidelines
- Use \`search\` to find relevant code before reading or editing files
- The query supports regex syntax
- Use \`include\` to narrow down to specific file types
- Output is truncated at 100 matches`,

  find: `## find

Search for files by name pattern using \`find\` (with \`-iname\` for case-insensitive matching).

### Parameters
- **pattern** (optional) — File name glob pattern. Omit to match all files.
- **search_dir** — Directory to search in (defaults to cwd)
- **max_depth** — Max directory depth (default 5)
- **type** — File type: \`f\` (files), \`d\` (directories)
- **extra_args** — Additional find arguments for complex queries (e.g. \`-o -iname "*.css" -o -iname "*.json"\` for OR patterns). When used, \`pattern\` is combined with \`extra_args\`.

### Guidelines
- Use \`extra_args\` for OR patterns: \`pattern="*.ts"\`, \`extra_args="-o -iname \\"*.tsx\\" -o -iname \\"*.css\\""\`
- Combine \`type=f\` with \`pattern\` to find files by type and name
- Use \`type=f\` without \`pattern\` to list all files in a directory
- For content search, use \`search\` instead
- Automatically excludes node_modules, .git, and hidden directories
- Prefer this over \`exec find\` — it is safer and faster`,

  ask_user: `## ask_user

Interaction Selection Tool

### Core Mandatory Rules
1. If you need to provide **2 or more fixed options** for the user to choose from, **you MUST call this tool first**. Do NOT list options directly in natural language.
2. For fully open-ended questions, simple information clarification, or casual confirmation, reply naturally without using this tool.
3. Use ask_user uniformly for single choice, multiple choice, plan selection and feature option switching scenarios.
4. Do NOT join options into a comma-separated string; choices must be passed as a **string array**.
5. If the user declines to choose, the tool return value is "CANCELLED". Stop option inquiry and switch to free conversation afterward.

### Parameter Description
- prompt: Required. Clear guiding question.
- choices: Required. Option list in string array format.
- multi: Optional. true = multiple selection; false = single selection, default single choice.

### Usage Criteria
- Fixed available options → Mandatory use of ask_user
- No options, fully open question → Reply directly in natural conversation`,

  exec: `## exec

Execute a shell command on the local machine.

### Platform notes
- **macOS/Linux**: runs in \`/bin/bash\`. Full POSIX/bash syntax supported.
- **Windows**: runs in \`powershell.exe\` (Windows PowerShell 5.x). Many Unix aliases available (\`ls\`, \`cat\`, \`pwd\`, \`cp\`, \`mv\`, \`rm\`, \`mkdir\`). NOT available: \`grep\`, \`tail\`, \`head\`, \`chmod\`, \`chown\`, \`sudo\`, \`&&\` chaining. Use \`;\` to chain commands on Windows.

### Parameters
- **command** (required) — The shell command to execute
- **cwd** — Working directory (defaults to home directory)
- **timeout** — Idle timeout in seconds (default 60). The command is killed only if it produces no output for this duration.
- **sudo** — Run with admin privileges (macOS: password dialog, Windows: UAC)

### Guidelines
- Prefer safe, read-only commands unless the user explicitly asks for modifications
- Use \`read\`, \`search\`, and \`list_dir\` for exploring filesystem — they are safer
- On **Windows**, avoid \`&&\` (not supported). Use \`;\` or separate tool calls instead.
- Always explain what the command does and why you are running it
- Commands are automatically killed after 60s of inactivity or 1MB output
- For long-running operations that produce continuous output, increase the \`timeout\` parameter`,

	  memory_search: `## memory_search

Search across all past conversations and explicitly saved memories.

### Parameters
- **query** (required) — Search query (use specific keywords for best results)
- **category** — Filter by category: code, architecture, user_pref, decision, general
- **limit** — Max results (default 5)

### Guidelines
- Use this tool when you need to recall past decisions, preferences, or context
- Be specific in your query for best results
- The search covers both auto-extracted memories and manually saved ones`,

  memory_save: `## memory_save

Save an important piece of information to long-term memory. This data persists across sessions.

### Parameters
- **content** (required) — What to remember. Be specific and include context.
- **type** — One of: fact (something true), decision (a choice made), preference (user's preference)
- **category** — One of: code, architecture, user_pref, decision, general

### Guidelines
- Save information when the user says "remember this" or "note that"
- Save user preferences when they are clearly stated
- Save architectural decisions and important context about the project
- Don't save transient chat — only durable information`,

  conversation_search: `## conversation_search

Search past conversations by keyword or look up by specific ID.

### Parameters
- **id** (optional) — The conversation ID to look up directly (e.g. "conv_20260430152243").
- **query** (optional) — Keyword to search across conversation titles, summaries, and keywords. Max 20 results.

Provide at least one of "id" or "query". When both are given, "id" takes priority.

### Returns
For **id** lookup: title, summary, and ID of the matching conversation.
For **query** search: a list of matching conversations with title, summary, keywords, and last-updated time.
Returns "not found" if nothing matches.`,

  tool_result_search: `## tool_result_search

Look up the original content of one or more compressed tool results by their tool_result_id. When a tool result has been compressed via nanoCompact, its content is replaced with \`[tool_result_id: <uuid>]\`. Use this tool to retrieve the full original content.

### Parameters
- **ids** (required) — An array of tool_result_id values to look up. Pass one or multiple IDs.

### Returns
- The original tool_result content including which conversation and tool_use it belongs to
- If an ID is not found, it will be omitted from results with a note`,

  pick_skill: `## pick_skill

Selects and activates a skill. Supports two modes:

### Mode 1 — Intent-based matching (default)
Provide an **intent** describing what the user needs, and a sub-agent LLM selects the best match.

### Mode 2 — Direct name lookup
Provide the exact **name** of a known skill to activate it directly, bypassing LLM selection.

### Parameters
- **intent** (optional) — Describe what the user needs help with. Be specific. Used for automatic skill matching.
- **name** (optional) — The exact skill name to activate directly. When provided, intent is ignored.

One of "intent" or "name" must be provided.

### How it works
1. All enabled skills are gathered
2. If "name" is provided, the skill is looked up directly
3. Otherwise, a sub-agent LLM call selects the best match
4. The selected skill's instructions are returned
5. Follow the returned skill instructions carefully

### Guidelines
- Use "name" when you know the exact skill you want
- Use "intent" for automatic matching when uncertain
- If no skill matches, the tool will return "No matching skill found"

### Past experiences
The Experience Index in your system prompt lists past experiences (lessons learned from earlier sessions) by name. When a task matches a listed experience, pass its exact name here to read it in full — the experience may contain valuable pitfalls and optimizations for similar work.`,

  knowledge_search: `## knowledge_search

Search across the local knowledge base. Returns a list of knowledge files with their metadata.

### Parameters
- **query** (optional) — Text to search for (title and/or content, depends on mode)
- **mode** (optional) — Search mode:
  - \`"title"\` (default) — match by file name/title
  - \`"content"\` — search within raw file text (FTS5). Returns excerpts with matching context.
  - \`"both"\` — search both title and content
  - \`"wiki"\` — lightning-fast ripgrep search across compiled wiki pages (\`sources/\`, \`entities/\`, \`concepts/\`, \`syntheses/\`). Use this FIRST when you need to find compiled knowledge. Wiki results include page paths that can be passed to \`knowledge_read\` with \`type="wiki"\`. When the matched snippet isn't enough, follow markdown links in a wiki page to traverse to related entities, concepts, or syntheses.
- **sourceType** (optional) — Filter by source: file, url, or experience
- **status** (optional) — Filter by status: raw or compiled

### Usage strategy
1. **Prefer \`mode="wiki"\`** for most knowledge lookups — it searches LLM-compiled wiki pages directly via ripgrep and returns structured results
2. If wiki search yields insufficient detail, use \`mode="title"\` or \`mode="content"\` to search the original raw files
3. Combine with \`knowledge_read\` to view the full content of a matched file or wiki page
4. Wiki pages often contain markdown links to related pages — follow them for deeper exploration`,

  knowledge_read: `## knowledge_read

Read the content of a knowledge base file or compiled wiki page.

### Parameters
- **path** (required) — The file path (raw path or wiki path, see below)
- **type** (optional) — "wiki" for compiled wiki pages, "raw" for imported source documents (default "raw")

### Guidelines
- Use after knowledge_search to view full document content
- **Wiki pages** are stored at paths like \`sources/xxx.md\`, \`entities/xxx.md\`, \`concepts/xxx.md\`, \`syntheses/xxx.md\` — use \`type="wiki"\` for these
- **Raw files** use the filePath from search results — use \`type="raw"\` for these
- Check the \`knowledge_search\` output carefully: it shows which path and type to use
- Compiled files may have multiple wiki pages — each one has a different path`,

  experience_read: `## experience_read

Read the full content of a past workflow experience when it is relevant to the current task.

### Parameters
- **name** (required) — The experience name, exactly as shown in the Experience Index

### Guidelines
- Use when the Experience Index mentions an experience relevant to the current task
- The experience contains structured sections: Background / Process / Problems / Optimization
- Apply the Optimization section as a lesson when performing the same kind of task
- Reading an experience is the only way its full content becomes available — the index only shows titles`,

  spawn_agent: `## spawn_agent

Select the **most suitable sub-agent** from the available list and delegate a task to it.

### Parameters
- **subAgentId** (required) — The ID of the sub-agent to use. Choose the one best suited for the task.
- **task** (required) — Detailed description of what the sub-agent should do

### How it works
1. Review the available sub-agents list above — each has different tools, MCP servers, and expertise
2. Pick the one best suited for the task at hand
3. The sub-agent starts with its own base prompt and runs independently
4. When complete, its results are returned as the tool result

### Guidelines
- Use for complex, self-contained sub-tasks (research, analysis, code review, refactoring)
- Be very specific about what context the sub-agent needs
- Specify the expected output format in the task description
- The sub-agent CANNOT install skills or modify tool preferences`,

  create_plan: `## create_plan

Create a structured plan before starting complex multi-step work.

### Parameters
- **objective** (required) — What this plan aims to achieve
- **steps** (required) — Ordered list of step descriptions
- **mode** — Always \`"delegated"\`. Each step runs in an isolated sub-agent via \`spawn_agent\`. The \`mode\` parameter is ignored — all plans use delegated execution.

### When to use
- The task requires 3+ coordinated tool calls
- Different approaches need to be explored
- Work involves multiple files or systems

### How it works
1. **Before creating a plan**, first investigate the overall situation — understand the codebase structure, relevant files, and context using tools like \`read\`, \`search\`, \`list_dir\`, and \`webfetch\`
2. Call \`create_plan\` with a clear objective and ordered steps based on your investigation
3. The plan is injected into every subsequent LLM request as context
4. Use \`advance_plan\` to mark progress: complete a step, handle failure, or finish
5. The current step is always highlighted — focus on completing it before moving on

### Delegated execution (always on)
Each step MUST be executed by calling \`spawn_agent\` with the step description as the task. Pass the previous steps' results as context to the next sub-agent. Your role becomes: plan, dispatch, verify results, and advance the plan.

**Do not attempt to complete multiple steps in a single response** — one step per cycle, use \`advance_plan\` then proceed to the next.`,

  advance_plan: `## advance_plan

Update plan progress. Call this after completing, failing, or finishing the current step.

### Parameters
- **action** (required) — \`complete\` (step done, advance), \`fail\` (step failed, stay), \`finish\` (entire plan done)
- **notes** — Optional notes about what happened

### Actions
- \`complete\` — Marks current step as completed and moves to the next step. Call this when the step's goal is achieved.
- \`fail\` — Marks current step as failed. The plan stays on this step so you can retry or adjust your approach. Explain what went wrong in \`notes\`.
- \`finish\` — Marks the entire plan as complete. Call this when all steps are done or the objective has been met.`,

  pick_tool: `## pick_tool

Select and activate hidden tools — MCP (Model Context Protocol) tools from servers, or gated built-in tools (git / memory / knowledge categories). Use this to discover available tools and activate the ones you need.

Built-in categories auto-activate when the conversation mentions their topic (e.g. "commit", "branch", "记得", "知识库"), but you can also activate them explicitly here.

### Mode 1 — Direct name lookup
Provide the exact **names** of tools to activate them directly (e.g. list_pages, git_status, memory_search).

### Mode 2 — Load a unit
Provide a **serverName** — a server id (e.g. chrome-devtools) or a built-in category (e.g. git, memory, knowledge) — to load all its tools.

### Mode 3 — Intent-based matching
Provide an **intent** describing what you need, and a sub-agent LLM selects the best matching servers and categories.

### Parameters
- **names** (optional) — Array of exact tool names to activate directly. When provided, intent is ignored.
- **serverName** (optional) — Server id or built-in category id (e.g. chrome-devtools, git, memory, knowledge) to load all its tools.
- **intent** (optional) — Describe what you want to accomplish. Used for automatic tool matching.

One of "names", "serverName", or "intent" must be provided.

### How it works
1. Available servers and built-in categories are listed in this tool's description
2. If "names" is provided, those tools are activated directly
3. Otherwise, a sub-agent LLM call selects the best matching units
4. The selected tool definitions are returned so you can use them
5. Selected tools become available as regular tools in subsequent turns

### Guidelines
- Use "names" when you know exactly which tools you need
- Use "serverName" to load an entire server or category
- Use "intent" for automatic matching when uncertain
- Git/memory/knowledge categories auto-activate on keyword mention; call pick_tool to activate them explicitly when needed
- You can call pick_tool again later to activate additional tools`,

  install: `## install

Install a skill or register an MCP server.

**IMPORTANT**: You MUST first activate the \`create_skill\` or \`create_mcp\` skill and follow its instructions to prepare the required files on disk. Do NOT call this tool directly without following those guides — the configuration files must be written first.

### Mode 1 — Install a skill (type: "skill")
1. Activate the \`create_skill\` skill and follow its steps to write a SKILL.md file to \`~/.pulsemind/skills/<name>/SKILL.md\`
2. Then call \`install({type: "skill", name: "<name>"})\` to register and enable it

### Mode 2 — Register an MCP server (type: "mcp")
1. Activate the \`create_mcp\` skill and follow its steps to add the server configuration to \`~/.pulsemind/mcp/mcp-servers.json\`
2. Then call \`install({type: "mcp", name: "<server name>"})\` to register and start it

### Parameters
- **type** (required) — "skill" or "mcp"
- **name** (required) — For "skill": the skill directory name. For "mcp": the server name in mcp-servers.json (matching config.name)

### Examples
- Install a skill: \`install({type: "skill", name: "my-skill"})\`
- Register an MCP server: \`install({type: "mcp", name: "my-server"})\``,

  webfetch: `## webfetch

Fetch a URL and return its content as text. Use for retrieving web pages, API responses, or submitting data.

### Parameters
- **url** (required) — The URL to fetch
- **method** — HTTP method: GET (default) or POST
- **headers** — Optional HTTP headers as key-value pairs (e.g. {"Authorization": "Bearer xxx"})
- **body** — Request body for POST requests (plain text or JSON string)
### Output Format
Small responses (≤10KB) are returned inline with a metadata header:
\`\`\`
--- WebFetch ---
  URL: <url>
  Method: <method>
  Size: <chars>
--- End WebFetch ---

<content>
\`\`\`

Large responses (>10KB) are saved to \`~/.pulsemind/tmp/webfetch_<url>.txt\` and only the first 10KB is shown inline with a \`Note:\` pointing to the full file.

### Guidelines
- Use GET for read-only data retrieval
- Use POST for sending data to APIs
- Response is limited to 50MB with a 30s timeout`,

  git_status: `## git_status

Check the current state of a git repository (branch, ahead/behind, staged/unstaged/untracked files, conflicts).

### Parameters
- **cwd** — Directory to run git in (default: workspace). Must be inside a git repo, otherwise returns isRepo:false.

### Guidelines
- Call before modifying files to understand the repo state
- Returns porcelain-formatted change lines — keep them concise in your output
- Use \`git_diff\` for details before deciding what to change`,

  git_diff: `## git_diff

Show the diff of a git repository — staged, unstaged, or both.

### Parameters
- **cwd** — Directory to run git in
- **files** — Optional list of paths to restrict the diff to
- **staged** — If true, show only staged (index) changes (uses --cached)
- **statOnly** — If true, show only a --stat summary (line counts per file) instead of the full diff

### Guidelines
- After editing files, call \`git_diff\` to verify the changes match what you intended
- Use \`statOnly: true\` for a quick impact overview before a big diff
- Paths are always separated with \`--\` so file names starting with \`-\` are safe`,

  git_log: `## git_log

Show recent commit history (one line per commit).

### Parameters
- **cwd** — Directory to run git in
- **n** — Number of commits to show (default 20)

### Guidelines
- Use to understand recent work before writing a commit message
- Short hashes + subject lines are returned — good for referencing commits`,

  git_commit: `## git_commit

Create a commit in the git repository. Always make one commit per logical change.

### Parameters
- **cwd** — Directory to run git in
- **message** (required) — Commit message. Follow Conventional Commits: \`feat:\`, \`fix:\`, \`refactor:\`, \`docs:\`, \`chore:\`, etc.
- **files** — Optional list of paths to stage and commit. If omitted, commits the currently staged changes.

### Guidelines
- Complete a group of related modifications, then commit them with a descriptive message
- The commit author is the user's configured git identity — never override it
- Returns the short hash and files-changed count on success`,

  git_restore: `## git_restore

Revert tracked files back to their state at HEAD. DANGEROUS — use with care.

### Parameters
- **cwd** — Directory to run git in
- **files** (required) — Paths to restore
- **confirm** — Must be true to actually execute. Without it, returns a preview of what would be restored.

### Guidelines
- By default this tool only returns a \`git diff --stat\` preview plus the affected status lines
- After reviewing the preview, call again with \`confirm: true\` to execute
- Untracked files cannot be restored by \`git restore\` — they are unaffected
- Never restore more files than necessary; prefer explicit file lists`,
}
