import type { SkillDefinition } from './types'
import { OFFICE_SKILL_PROMPT } from './built-in/office-route'
import { OFFICE_SKILL_REFERENCES } from './built-in/office-references'
import { CODING_WORKFLOW_PROMPT } from './built-in/coding-workflow'
import { CODING_WORKFLOW_REFERENCES } from './built-in/coding-workflow-references'
import { BROWSER_SKILL_PROMPT } from './built-in/browser'

/**
 * Built-in skills that ship with PulseMind.
 *
 * Each skill is a prompt template that shapes how the AI approaches
 * a task — unlike tools, skills do NOT create Anthropic tool_use
 * definitions. They are pure system prompt injection.
 */
export const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    name: 'create_skill',
    description:
      'Guides the AI to help users create, edit, or package custom skills for PulseMind. Walks through SKILL.md structure, YAML frontmatter, and zip packaging.',
    category: 'pulsemind',
    builtIn: true,
    triggers: ['skill', '技能'],
    systemPrompt: `## Active Skill: Create Skill

When the user wants to create or edit a PulseMind skill, follow this process:

### Skill Structure
Each skill is a directory containing a \`SKILL.md\` file with YAML frontmatter:

\`\`\`markdown
---
name: my_skill
description: What this skill does
category: general
triggers:
  - keyword1
  - keyword2
---
## Active Skill: My Skill

Full system prompt instructions go here...
\`\`\`

### Frontmatter Fields
- **name** (required) — Unique snake_case identifier
- **description** (required) — Short description shown in the UI
- **category** (required) — Grouping for the skills panel
- **triggers** (optional) — Keywords for future auto-activation

### Process
1. Clarify what the user wants the skill to accomplish
2. Draft the skill prompt content together
3. Write the file directly — the skills directory \`~/.pulsemind/skills/\` is writable with the \`write\`/\`edit\` tools: create \`~/.pulsemind/skills/<skill_name>/SKILL.md\` (frontmatter + body). **Revising an existing skill**: \`read\` its current SKILL.md FIRST, then apply targeted \`edit\` calls — several small edits beat one whole-file rewrite; reach for a whole-file \`write\` only when the structure itself changes. NEVER write over a skill file you have not read this session (that silently discards someone else's edit), and verify what landed (re-\`read\` the changed region, or \`diff\`/\`shasum\` against what you intended) before reporting done.
4. Edits need NO re-enable and NO re-registration: \`pick_skill\` re-reads SKILL.md from disk on every call, so the next pick serves the new body immediately; only the registry's description/triggers (used for matching) wait for the next session. The Skills panel reads the file from disk, so it shows the edit on its next open. A NEWLY created skill does need one registration to take effect: call the \`install\` tool with \`type: "skill"\` and \`name\` set to the skill's name — this parses, registers and enables it, and it appears in the Skills panel. (Alternative for short skills: \`install\` with the full text as \`content\` does the write + registration in one step, but it never overwrites — revisions go through \`edit\`.)
5. Built-in skills' files can be edited too, but a hand-edited built-in no longer receives the app's automatic seed upgrades — when diverging from a built-in, prefer creating a new skill under a new name.
6. If the user wants to share or back up the skill, the skill directory is located at \`~/.pulsemind/skills/<skill_name>/\` — they can manually zip it or copy the \`SKILL.md\` file`,
  },
  {
    name: 'create_mcp',
    description:
      'Guides the AI to help users configure and register MCP (Model Context Protocol) servers for PulseMind. Covers mcp-servers.json format, transport modes, and installation.',
    category: 'pulsemind',
    builtIn: true,
    triggers: ['mcp'],
    systemPrompt: `## Active Skill: Create MCP Server

When the user wants to configure and register an MCP server for PulseMind, follow this process:

### Server Config Format

The \`install\` tool registers an MCP server straight from a config object — no config file is written or needed:

\`\`\`json
{
  "name": "my-server",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
  "env": {}
}
\`\`\`

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`name\` | string | yes | Unique server identifier |
| \`command\` | string | yes* | Executable to run (required for \`stdio\` transport) |
| \`args\` | string[] | no | Command-line arguments |
| \`env\` | object | no | Additional environment variables |
| \`transportType\` | string | no | \`"stdio"\` (default, local subprocess), \`"sse"\` (remote HTTP server), or \`"streamable-http"\` (streamable HTTP) |
| \`url\` | string | no* | Endpoint URL (required for \`sse\` / \`streamable-http\` transport) |
| \`headers\` | object | no | Custom HTTP headers for SSE transport (e.g. \`{"Authorization": "Bearer xyz"}\`) |
| \`requireApproval\` | boolean | no | When true, this server's tools wait for user approval each call |

### Process

1. **Determine the server type** — Ask the user what MCP server they want to set up:
   - **stdio** — A local executable (e.g. npx, node script, Python script). Requires \`command\` and optionally \`args\`.
   - **sse** — A remote HTTP server using Server-Sent Events. Requires \`url\`.
   - **streamable-http** — A remote HTTP server with streaming support. Requires \`url\`.

2. **Build the config object** — Assemble the fields per the table above. For stdio servers, verify the command is available (e.g. \`npx\`, \`node\`, \`python\` are common). Validate that \`name\` is unique among the user's servers.

3. **Install** — Call \`install({type: "mcp", config: <the object>})\` — the server is registered straight from the object and started in the same call. Do NOT write \`mcp-servers.json\` first: it lives inside the app's protected data root (\`~/.pulsemind\`), where the \`write\` tool is refused; existing servers are never touched by this path.

4. After installation, the MCP server's tools become available to the AI in the conversation.

### Important Notes
- Validate that \`name\` is unique among the user's registered servers — registering the same name twice creates two server entries
- After installation, the MCP server's tools become available to the AI in the conversation`,
  },

  {
    name: 'office',
    description:
      'Office deliverables (Word / Excel / PPT / PDF): how to choose between generating a new file and byte-faithfully editing an existing one, and the per-format specs each route leads to. Pick it whenever the input or the deliverable is an Office file.',
    category: 'office',
    builtIn: true,
    triggers: [
      'docx',
      'xlsx',
      'pptx',
      'excel',
      'powerpoint',
      'ppt',
      '幻灯片',
      '演示文稿',
      'word文档',
      'word 文档',
      '排版',
      '公文',
      '合同',
      '简历',
      '导出文档',
    ],
    systemPrompt: OFFICE_SKILL_PROMPT,
    // The per-format rule sets SKILL.md points at. Seeded to
    // ~/.pulsemind/skills/office/references/ by ensureBuiltInSkills — pick_skill
    // only returns the body, so these have to be on disk for `read` to reach.
    resources: OFFICE_SKILL_REFERENCES,
  },

  {
    name: 'coding-workflow',
    description:
      'Long-tail coding work organization (PLAN-coding-contract P2): routing across six scenarios — large refactor, code review, migration, debugging/root-cause, new feature delivery, performance work — with the per-scenario discipline in reference files. The always-on engineering contract (read before write / verify before claim / no invented API) is NOT here — it ships in the frozen core; this skill adds how to stage work bigger than a few lines.',
    category: 'pulsemind',
    builtIn: true,
    triggers: [
      '重构',
      '重构一下',
      '大改',
      '迁移',
      'review 代码',
      '代码评审',
      'code review',
      '排查',
      '调试',
      'bug',
      '性能',
      '新功能',
    ],
    systemPrompt: CODING_WORKFLOW_PROMPT,
    resources: CODING_WORKFLOW_REFERENCES,
  },

  {
    // 2026-10-26 (user ruling, 系统提示词瘦身): the `browser` tool's own manual
    // moved here out of the tool-instructions.ts trunk, where it rode EVERY
    // request (~1.4K tokens on plain chats too). The tool stays always-on —
    // its schema is ~0.7K — and these triggers drive the state-block keyword
    // hint toward pick_skill. Deliberate inverse of the 2026-09-18 browser_use
    // retirement: that one moved the skill INTO the trunk to save a sync copy,
    // this one moves the manual back OUT to save the floor (pick_skill re-reads
    // SKILL.md from disk on every call, so there is still exactly one copy).
    name: 'browser',
    description:
      'The full calling convention for the browser tool: snapshot ref addressing (incl. frame-prefixed refs), diff snapshots, one action per observation, tab rebinding, favorites, and the real-input playbook for canvas apps. Pick it before the first browser call of a session.',
    category: 'browser',
    builtIn: true,
    triggers: ['浏览器', '网页', '网址', '网站', 'browser'],
    systemPrompt: BROWSER_SKILL_PROMPT,
  },
]

/**
 * Built-ins that no longer ship. `ensureBuiltInSkills` seeded each of them to
 * ~/.pulsemind/skills/<name>/SKILL.md, where `listImported` still finds it and
 * re-registers it as a user skill — so a retired name needs its seeded copy
 * swept on startup.
 *
 * `contentHash` is `skillContentSignature()` of the definition as it LAST
 * SHIPPED. It is FROZEN provenance, not a copy to maintain: it must never be
 * edited to follow the text to wherever it moved (the byte compare this
 * replaces judged the file against itself and broke the moment the formatter
 * changed; judging against the retired definition instead is what makes the
 * compare survive formatting drift). The sweep deletes a file whose signature
 * matches this hash — or matches the seed manifest entry recorded when the app
 * itself wrote the file — and keeps everything else: a user edit, an
 * unparseable file, or a body no record covers (a seed of a superseded
 * definition from before the manifest existed). Recompute with
 * `skillContentSignature(<the definition>)` when retiring a skill;
 * tests/retired-skill-sweep.test.ts pins the values below.
 */
export const RETIRED_BUILT_IN_SKILLS: { name: string; contentHash: string }[] = [
  {
    name: 'browser_use',
    // Retired 2026-09-18: its protocol moved verbatim into the `browser`
    // tool's own `instructions` manual (tool-instructions.ts), which ships in
    // every request via buildToolProtocols — no trigger/pick_skill round trip,
    // and no second copy to keep in sync. (2026-10-26: that manual moved again,
    // out of the trunk into the new `browser` built-in skill — see
    // BUILT_IN_SKILLS. This hash stays frozen at the 2026-09-18 text either way.)
    contentHash: 'dd75a33b822ab9e243e68d0b14af5924a904ea43522a180750a177b864e246c6'
  },
  {
    name: 'web_gui_tester',
    // Retired 2026-10-26 (user decision). Pure testing-discipline overlay on
    // the `browser` tool's own manual — no protocol moved anywhere; the hash
    // is simply the final text frozen.
    contentHash: '829cacbbe84154fdc40f08e7bb79b1801e9b5ca3fd5256b02383bcea9127f895'
  }
]
