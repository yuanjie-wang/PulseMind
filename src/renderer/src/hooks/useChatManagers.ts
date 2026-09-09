import { useEffect, useRef, useState, useCallback } from 'react'
import { ToolManager } from '../tools/ToolManager'
import { SkillManager } from '../skills/SkillManager'
import { MemoryManager } from '../memory/MemoryManager'
import { KnowledgeManager } from '../knowledge/KnowledgeManager'
import { ExperienceManager } from '../experiences/ExperienceManager'
import type { ToolState } from '../tools/types'
import type { SkillState } from '../skills/types'
import { BUILT_IN_SKILLS } from '../skills/built-in-skills'
import { SkillKeywordAgent } from '../agent/one-shot-agent'
import type { LlmConfig } from '../agent/one-shot-agent'
import type { PlatformInfo } from '../types/electron'
import type { LlmAdapter } from '../llm/adapter'

// ── Helpers ──

/** Backfill trigger keywords for a skill that doesn't have them yet. */
async function backfillSkillKeywords(
  skillName: string,
  agent: SkillKeywordAgent,
  llmConfig: LlmConfig
): Promise<void> {
  if (!llmConfig.apiKey) return
  try {
    const rawContent = await window.electronAPI.readSkillRaw(skillName)
    if (!rawContent) return

    const keywords = await agent.execute(
      { rawContent },
      { llmConfig, maxTokens: 500 }
    )

    if (keywords.length > 0) {
      const prefs = await window.electronAPI.getSkillPreferences()
      const skillKeywords = prefs.skillKeywords || {}
      if (!skillKeywords[skillName]) {
        skillKeywords[skillName] = keywords
        await window.electronAPI.setSkillPreferences({ ...prefs, skillKeywords })
        console.log(`[backfill] Extracted keywords for "${skillName}":`, keywords)
      }
    }
  } catch (err) {
    console.warn(`[backfill] Failed to extract keywords for "${skillName}":`, err)
  }
}

// ── Hook ──

interface UseChatManagersOptions {
  apiKey: string | null
  baseURL: string
  model: string
  adapter: LlmAdapter
}

export function useChatManagers(options: UseChatManagersOptions) {
  const { apiKey, baseURL } = options

  // Stable manager instances
  const memoryManagerRef = useRef<MemoryManager>(new MemoryManager())
  const knowledgeManagerRef = useRef<KnowledgeManager>(new KnowledgeManager())
  const experienceManagerRef = useRef<ExperienceManager>(new ExperienceManager())
  const toolManagerRef = useRef<ToolManager>(new ToolManager())
  const skillManagerRef = useRef<SkillManager>(new SkillManager())

  // Tool/skill state
  const [tools, setTools] = useState<ToolState[]>(toolManagerRef.current.getAllTools())
  const [skills, setSkills] = useState<SkillState[]>(skillManagerRef.current.getAllSkills())
  const [importError, setImportError] = useState<string | null>(null)

  // Preferences loading state
  const prefsLoadedRef = useRef(false)
  const toolsReadyRef = useRef(false)
  const skillsReadyRef = useRef(false)
  const platformInfoRef = useRef<PlatformInfo | null>(null)
  const [skillsDir, setSkillsDir] = useState('')

  // Agent for keyword extraction
  const skillKeywordAgentRef = useRef(new SkillKeywordAgent())

  // ── Load preferences on mount ──
  useEffect(() => {
    async function loadPrefs() {
      if (prefsLoadedRef.current) return
      prefsLoadedRef.current = true
      try {
        const [toolPrefs, skillPrefs, importedDefs, platformInfo, dataPaths] = await Promise.all([
          window.electronAPI.getToolPreferences(),
          window.electronAPI.getSkillPreferences(),
          window.electronAPI.listImportedSkills(),
          window.electronAPI.getPlatformInfo(),
          window.electronAPI.getDataPaths()
        ])
        platformInfoRef.current = platformInfo
        setSkillsDir(dataPaths.skillsDir)
        toolManagerRef.current.applyPreferences(toolPrefs)
        for (const def of importedDefs) {
          skillManagerRef.current.registerSkill(def)
        }
        skillManagerRef.current.applyPreferences(skillPrefs)

        await window.electronAPI.ensureBuiltInSkills(BUILT_IN_SKILLS).catch(e =>
          console.error('[loadPrefs] Failed to write built-in skills:', e)
        )
        setTools(toolManagerRef.current.getAllTools())
        setSkills(skillManagerRef.current.getAllSkills())

        const seededPrefs = skillManagerRef.current.getPreferences()
        if (seededPrefs.skillKeywords) {
          await window.electronAPI.setSkillPreferences(seededPrefs)
        }

        queueMicrotask(() => {
          toolsReadyRef.current = true
          skillsReadyRef.current = true
        })
      } catch (err) {
        console.error('[useChatController] Failed to load preferences, using defaults:', err)
      }
    }
    loadPrefs()
  }, [])

  // ── Backfill skill keywords when API key becomes available ──
  useEffect(() => {
    if (!apiKey) return
    if (!prefsLoadedRef.current) return

    const run = async (): Promise<void> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (skillsReadyRef.current) break
        await new Promise(r => setTimeout(r, 200))
      }
      if (!skillsReadyRef.current) return

      try {
        const prefs = await window.electronAPI.getSkillPreferences()
        const existingKeywords = prefs.skillKeywords || {}
        for (const skill of skillManagerRef.current.getAllSkills()) {
          if (!existingKeywords[skill.definition.name]) {
            backfillSkillKeywords(
              skill.definition.name,
              skillKeywordAgentRef.current,
              { adapter: options.adapter, apiKey, baseURL: options.baseURL, model: options.model }
            )
          }
        }
      } catch (err) {
        console.warn('[backfill] Failed to process skills (non-critical):', err)
      }
    }
    run()
  }, [apiKey])

  // ── Persist tool preferences on toggle ──
  useEffect(() => {
    if (!prefsLoadedRef.current || !toolsReadyRef.current) return
    const prefs = toolManagerRef.current.getPreferences()
    window.electronAPI.setToolPreferences(prefs).catch((e) => {
      console.error('[persist] Failed to save tool prefs:', e)
    })
  }, [tools])

  // ── Persist skill preferences on toggle ──
  useEffect(() => {
    if (!prefsLoadedRef.current || !skillsReadyRef.current) return
    const persist = async (): Promise<void> => {
      const enabledPrefs = skillManagerRef.current.getPreferences()
      const existing = await window.electronAPI.getSkillPreferences()
      const prefs = { ...enabledPrefs, skillKeywords: existing.skillKeywords }
      await window.electronAPI.setSkillPreferences(prefs)
    }
    persist().catch((e) => {
      console.error('[persist] Failed to save skill prefs:', e)
    })
  }, [skills])

  // ── Tool toggling ──
  const toggleTool = useCallback((name: string): boolean | null => {
    const result = toolManagerRef.current.toggle(name)
    if (result !== null) {
      setTools(toolManagerRef.current.getAllTools())
    }
    return result
  }, [])

  // ── Skill toggling ──
  const toggleSkill = useCallback((name: string): boolean | null => {
    const result = skillManagerRef.current.toggle(name)
    if (result !== null) {
      setSkills(skillManagerRef.current.getAllSkills())
    }
    return result
  }, [])

  // ── Skill import ──
  const importSkill = useCallback(async () => {
    setImportError(null)
    try {
      const result = await window.electronAPI.importSkill()
      if (!result) return

      const prefs = await window.electronAPI.getSkillPreferences()
      const existingKeywords = prefs.skillKeywords || {}

      let changed = false
      for (const def of result.imported) {
        if (skillManagerRef.current.registerSkill(def)) {
          changed = true
          if (!existingKeywords[def.name] && apiKey) {
            backfillSkillKeywords(
              def.name,
              skillKeywordAgentRef.current,
              { adapter: options.adapter, apiKey, baseURL: options.baseURL, model: options.model }
            )
          }
        }
      }
      if (changed) {
        setSkills(skillManagerRef.current.getAllSkills())
      }
      if (result.errors.length > 0) {
        setImportError(result.errors.join('; '))
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    }
  }, [apiKey, baseURL, options.adapter, options.model])

  // ── Delete imported skill ──
  const deleteImportedSkill = useCallback(async (name: string) => {
    const ok = skillManagerRef.current.unregister(name)
    if (!ok) return

    try {
      const prefs = await window.electronAPI.getSkillPreferences()
      prefs.enabledSkills = prefs.enabledSkills.filter((s) => s !== name)
      if (prefs.skillKeywords?.[name]) {
        delete prefs.skillKeywords[name]
      }
      await window.electronAPI.setSkillPreferences(prefs)
    } catch (e) {
      console.warn('[deleteImportedSkill] Failed to update preferences:', e)
    }

    window.electronAPI.deleteImportedSkill(name).catch(() => {})
    setSkills(skillManagerRef.current.getAllSkills())
  }, [])

  const refreshSkills = useCallback(() => {
    setSkills(skillManagerRef.current.getAllSkills())
  }, [])

  /** Scan skills directory and register any new skills found on disk. */
  const refreshSkillsFromDisk = useCallback(async () => {
    if (!prefsLoadedRef.current) return
    try {
      const diskSkills = await window.electronAPI.listImportedSkills()
      const existingNames = new Set(skillManagerRef.current.getAllSkills().map(s => s.definition.name))
      const prefs = await window.electronAPI.getSkillPreferences()
      const existingKeywords = prefs.skillKeywords || {}

      let changed = false
      for (const def of diskSkills) {
        if (!existingNames.has(def.name)) {
          if (skillManagerRef.current.registerSkill(def)) {
            changed = true
            if (!existingKeywords[def.name] && apiKey) {
              backfillSkillKeywords(
                def.name,
                skillKeywordAgentRef.current,
                { adapter: options.adapter, apiKey, baseURL: options.baseURL, model: options.model }
              )
            }
          }
        }
      }
      if (changed) {
        setSkills(skillManagerRef.current.getAllSkills())
      }
    } catch (err) {
      console.warn('[refreshSkillsFromDisk] Failed to scan for new skills:', err)
    }
  }, [apiKey, options.adapter, options.baseURL, options.model])

  return {
    memoryManager: memoryManagerRef.current,
    knowledgeManager: knowledgeManagerRef.current,
    experienceManager: experienceManagerRef.current,
    toolManager: toolManagerRef.current,
    skillManager: skillManagerRef.current,
    tools,
    skills,
    importError,
    skillsDir,
    platformInfo: platformInfoRef.current,
    prefsLoadedRef,
    toolsReadyRef,
    skillsReadyRef,
    toggleTool,
    toggleSkill,
    importSkill,
    deleteImportedSkill,
    refreshSkills,
    refreshSkillsFromDisk
  }
}
