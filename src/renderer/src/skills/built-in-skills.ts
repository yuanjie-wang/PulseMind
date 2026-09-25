import type { SkillDefinition } from './types'
import { OFFICE_SKILL_PROMPT } from './built-in/office-route'
import { OFFICE_SKILL_REFERENCES } from './built-in/office-references'

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
3. Write the \`SKILL.md\` file using the \`write\` tool to \`~/.pulsemind/skills/<skill_name>/SKILL.md\`
4. Verify the file was created correctly
5. Install the skill using the \`install\` tool with \`type: "skill"\` and \`name\` set to the skill's name — this registers it in the skill system, enables it, and makes it appear in the Skills panel
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

### Configuration File Format

MCP server configurations are stored in \`~/.pulsemind/mcp/mcp-servers.json\` as a JSON array:

\`\`\`json
[
  {
    "config": {
      "name": "my-server",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
      "env": {}
    }
  }
]
\`\`\`

### Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| \`config.name\` | string | yes | Unique server identifier, used with \`install\` tool |
| \`config.command\` | string | yes* | Executable to run (required for \`stdio\` transport) |
| \`config.args\` | string[] | no | Command-line arguments |
| \`config.env\` | object | no | Additional environment variables |
| \`config.transportType\` | string | no | \`"stdio"\` (default, local subprocess), \`"sse"\` (remote HTTP server), or \`"streamable-http"\` (streamable HTTP) |
| \`config.url\` | string | no* | Endpoint URL (required for \`sse\` / \`streamable-http\` transport) |
| \`config.headers\` | object | no | Custom HTTP headers for SSE transport (e.g. \`{"Authorization": "Bearer xyz"}\`) |
| \`id\` | string | no | Auto-generated if omitted |
| \`autoStart\` | boolean | no | Whether to auto-start on app launch |

### Process

1. **Determine the server type** — Ask the user what MCP server they want to set up:
   - **stdio** — A local executable (e.g. npx, node script, Python script). Requires \`command\` and optionally \`args\`.
   - **sse** — A remote HTTP server using Server-Sent Events. Requires \`url\`.
   - **streamable-http** — A remote HTTP server with streaming support. Requires \`url\`.

2. **Read the existing config** — Use the \`read\` tool to load \`~/.pulsemind/mcp/mcp-servers.json\`. If the file doesn't exist yet, treat the config as an empty array \`[]\`.

3. **Add the new server entry** — Parse the existing JSON, append the new server config object, preserving all existing entries. Never remove or modify other servers.

4. **Write the config file** — Use the \`write\` tool to overwrite \`~/.pulsemind/mcp/mcp-servers.json\` with the updated array. Format it with 2-space indentation for readability.

5. **Install** — Call \`install({type: "mcp", name: "<config.name>"})\` to register the server and start it. The system will read the config from \`mcp-servers.json\`, register it, and start the MCP server automatically.

### Important Notes
- Always read the existing file first — do NOT overwrite existing server configurations
- Validate that \`config.name\` is unique (not already in the file)
- For stdio servers, verify the command is available (e.g. \`npx\`, \`node\`, \`python\` are common)
- After installation, the MCP server's tools become available to the AI in the conversation`,
  },

  {
    name: 'web_gui_tester',
    description:
      'Black-box GUI testing workflow on top of the browser tool: scenario plans, assertion discipline, console/network checks and structured bug reports. Loaded automatically for web testing / UI verification tasks.',
    category: 'pulsemind',
    builtIn: true,
    triggers: ['测试', 'web测试', '网页测试', 'ui测试', 'gui测试', '黑盒测试', '回归测试', '验收', 'testing', 'qa', 'test scenario'],
    systemPrompt: `## Active Skill: Web GUI Tester

You test web pages as a BLACK-BOX GUI tester through the \`browser\` tool. You never read the site's source — everything you know comes from snapshots, screenshots and page state. The \`browser\` tool's own manual (its Tool Protocols section, present in every request while the tool is enabled) carries the driving protocol — rebind, snapshot-first, one action per observation — and applies UNCHANGED; this skill adds the testing discipline on top.

### 1. Plan before you click
Before the first browser call, write a SHORT test plan to the user: scenarios, steps per scenario, expected results. Ask which scenarios matter if the task is vague — do not invent acceptance criteria silently.

### 2. Test in batches, verify by evidence
For each step: act → verify via a FRESH domSnapshot or an evaluate read of observable state (URL, input values, rendered text, element counts). "It didn't crash" is not a pass. Record actual vs expected for every step.

### 3. Look beyond the happy path
- Empty/required/invalid inputs, boundary values (0, 999+, unicode, emoji, very long strings)
- Double submits and rapid repeated clicks
- Back/forward navigation and refresh between steps
- Console errors: \`tab.evaluate("JSON.stringify(window.__errors || 'no hook')")\` only when the page exposes one; otherwise judge by broken UI state

### 4. Screenshots with judgment
Screenshot at visually-critical checkpoints (layout, overlap, empty states) — not after every click. A screenshot is evidence: describe WHAT it shows when you cite it.

### 5. Report format
End with a structured report:
- **结论** pass/fail per scenario, one line each
- **缺陷** for each failure: 复现步骤 (numbered), 预期 vs 实际, evidence (snapshot excerpt or screenshot reference), 严重级别 (阻塞/严重/一般/轻微)
- **未覆盖** what you could not test and why (login walls, captchas, payment flows)

### 6. Honesty rules
Never mark a scenario passed because you ran out of budget — say 未覆盖. If a modal/anti-bot wall blocks you, report it as an environment limitation, not a bug. Tell the user "已打开浏览器进行测试" — never mention kernel/sandbox/vm/CDP.`,
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
    // and no second copy to keep in sync.
    contentHash: 'dd75a33b822ab9e243e68d0b14af5924a904ea43522a180750a177b864e246c6'
  }
]
