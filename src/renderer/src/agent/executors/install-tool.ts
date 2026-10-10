// ── install: the conversation-side door into the app's own stores ──
// ~/.pulsemind is a path-jail DENY ROOT (shared/sandbox/path-jail): the
// model's write/edit tools are refused there, which is exactly why the old
// create_skill/create_mcp guides dead-ended — they told the model to prepare
// ~/.pulsemind/skills/<name>/SKILL.md or mcp-servers.json with the write tool
// first, and guardFsTarget denied every step. Since 2026-09-27 the payloads
// ride the tool call: `content` (a full SKILL.md) lands through
// SkillStore.writeRawSkill and `config` (an MCPClientConfig) through
// mcpRegisterServer — both guard-free store doors, the same shape as
// experience_save. The on-disk fallbacks below stay for paths a session can
// actually reach; their error messages now point at the inline parameters.

import { getHost } from '../host'
import type { ToolExecContext } from './context'
import type { ToolUseBlock } from '../../types/agent'
import type { MCPClientConfig } from '../../../../shared/types/electron-bridge'

/** install 的判型谓词，分类器与执行体的唯一共同来源（full_20261011 M2-P1-2）：
 *  审批梯子按 `type === 'mcp'` 把 install 挂 exec 档（注册完立即拉起 stdio
 *  进程），而这里的执行体对同一字段先 trim 再比较——`"mcp "` / `"MCP"` 曾被
 *  分类器判成「不是 install-mcp」落回 systemTools（永不 held），执行体却照样
 *  完成 MCP 注册。两侧必须对同一个 type 值给出同一个答案。 */
export function installTypeOf(t: Pick<ToolUseBlock, 'input'>): string {
  return String(t.input?.type || '').trim().toLowerCase()
}

export async function execInstallTool(ex: ToolExecContext, t: ToolUseBlock): Promise<void> {
  t.status = 'running'; ex.notify()
  try {
    const installType = installTypeOf(t)
    const name = String(t.input?.name || '').trim()
    if (!installType) throw new Error('Field "type" is required: "skill" or "mcp".')

    if (installType === 'skill') {
      const content = typeof t.input?.content === 'string' ? t.input.content : ''
      let skillName = name
      if (content.trim()) {
        t.output = `Writing skill "${name || '(from frontmatter)'}"...`; ex.notify()
        const res = await getHost().writeSkillSource(content, name || undefined)
        if (!res.ok) throw new Error(res.error)
        skillName = res.skill.name
      }
      if (!skillName) throw new Error('Field "name" is required — or pass the full SKILL.md text as "content" and omit "name".')
      t.output = `Installing skill "${skillName}"...`; ex.notify()
      const def = await getHost().installSkill(skillName)
      if (!def) throw new Error(`Skill "${skillName}" not found on disk at ~/.pulsemind/skills/${skillName}/SKILL.md. Pass the full SKILL.md text as "content", or write ~/.pulsemind/skills/${skillName}/SKILL.md yourself and retry.`)
      const sm = ex.opts.skillManager; sm!.registerSkill(def); sm!.enable(def.name)
      ex.opts.onSkillStateChange?.()
      t.exitCode = 0; t.status = 'completed'
      ex.addToolResult(t.id, `Skill "${def.name}" installed and enabled successfully.`, false)
      // keyword extraction (fire-and-forget garnish)
      const kwAgent = ex.skillKeywordAgent
      if (kwAgent) {
        try {
          const rawContent = await getHost().readSkillRaw(skillName)
          if (rawContent) {
            const keywords = await kwAgent.execute(
              { rawContent },
              {
                llmConfig: { adapter: ex.opts.adapter, apiKey: ex.opts.apiKey || '', baseURL: ex.opts.baseURL, model: ex.opts.model, modelMaxTokens: ex.opts.maxTokens },
                maxOutputTokens: 500
              }
            )
            if (keywords.length > 0) {
              // Patch-shaped atomic update (PLAN-parallel-experts T10): the old
              // get→patch→whole-set raced two experts installing in one round —
              // each shipped a full replacement and the later clobbered the
              // earlier's keyword backfill.
              await getHost().updateSkillPreferences({ setKeywordIfAbsent: { [def.name]: keywords } })
            }
          }
        } catch (err) { console.warn(`[install] Failed to extract keywords for "${def.name}":`, err) }
      }
    } else if (installType === 'mcp') {
      const inline = t.input?.config as MCPClientConfig | undefined
      if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
        // ── Register straight from the config object ────────────────────
        const serverName = String(inline.name || name)
        if (name && serverName !== name) {
          throw new Error(`Field "name" ("${name}") does not match config.name ("${serverName}"). Omit "name", or make them agree.`)
        }
        t.output = `Registering MCP server "${serverName}"...`; ex.notify()
        const result = await getHost().mcpRegisterServer(inline)
        if (!result.success || !result.server) throw new Error(result.error || `Failed to register MCP server "${serverName}".`)
        const serverId = result.server.id || ''
        if (serverId) await getHost().mcpStartServer(serverId).catch(() => {})
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mcp-state-changed'))
        t.exitCode = 0; t.status = 'completed'
        ex.addToolResult(t.id, `MCP server "${serverName}" registered and started successfully.`, false)
      } else {
        // ── Legacy on-disk flow ─────────────────────────────────────────
        if (!name) throw new Error('Field "name" is required — or pass the server config object as "config".')
        t.output = `Registering MCP server "${name}"...`; ex.notify()
        const configPath = '~/.pulsemind/mcp/mcp-servers.json'
        const configStr = await getHost().readFile(configPath)
        if (!configStr) throw new Error(`MCP config file not found at ${configPath} — it lives in the app's protected data root, which the write tool cannot reach. Pass the server config object as "config" instead.`)
        const records = JSON.parse(configStr)
        const record = Array.isArray(records) ? records.find((r: { config?: { name?: string }; name?: string }) => r.config?.name === name || r.name === name) : null
        if (!record) throw new Error(`MCP server "${name}" not found in ${configPath}.`)
        const rawConfig = record.config || record
        const result = await getHost().mcpRegisterServer(rawConfig)
        const serverId = result.server?.id || ''
        if (serverId) await getHost().mcpStartServer(serverId).catch(() => {})
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mcp-state-changed'))
        t.exitCode = 0; t.status = 'completed'
        ex.addToolResult(t.id, `MCP server "${name}" registered and started successfully.`, false)
      }
    } else {
      throw new Error(`Unknown install type "${installType}". Must be "skill" or "mcp".`)
    }
  } catch (err) { ex.addToolResult(t.id, `Error: ${err instanceof Error ? err.message : 'install failed'}`, true); t.exitCode = -1 }
  ex.notify()
}
