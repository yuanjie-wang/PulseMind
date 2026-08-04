import type { SkillDefinition } from './types'

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
    triggers: [
      'skill',
      '技能'
    ],
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
    triggers: [
      'mcp'
    ],
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
]
