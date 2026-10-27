// ── Per-conversation 模型 (the composer's model picker) ──
// The model used to be one global field (`settings.activeProfileId`): every
// conversation followed it, and any picker click — desktop composer, settings
// panel, extension panel — moved them all. A conversation can now pin its own
// profile (`conversations.profile_id`, same shape as `approval_mode`), the
// settings panel's picker sets only the DEFAULT, and a welcome-picked model is
// held for the conversation the first message creates.
//
// The DB roundtrip is covered by `scripts/probe-conversation-profile.mjs`
// (better-sqlite3 is Electron-ABI and cannot load under plain Node); this file
// runs the pending store for real and pins the wiring as source scans, because
// vitest here is node-env and cannot mount the hooks.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  usePendingProfileStore,
  takePendingProfileId,
} from '../src/renderer/src/stores/pendingProfileStore'

describe('pendingProfileStore', () => {
  beforeEach(() => {
    usePendingProfileStore.setState({ profileId: null })
  })

  it('starts empty, so the welcome composer shows the default model', () => {
    expect(usePendingProfileStore.getState().profileId).toBeNull()
  })

  it('holds a model picked with no conversation to write to', () => {
    usePendingProfileStore.getState().setProfileId('prof_a')
    expect(usePendingProfileStore.getState().profileId).toBe('prof_a')
  })

  it('hands the held choice to the materialization path exactly once', () => {
    usePendingProfileStore.getState().setProfileId('prof_a')

    expect(takePendingProfileId()).toBe('prof_a')
    // Consumed: the next new conversation must not inherit it a second time.
    expect(takePendingProfileId()).toBeNull()
    expect(usePendingProfileStore.getState().profileId).toBeNull()
  })

  it('keeps the latest choice when the user changes their mind', () => {
    usePendingProfileStore.getState().setProfileId('prof_a')
    usePendingProfileStore.getState().setProfileId('prof_b')
    expect(takePendingProfileId()).toBe('prof_b')
  })
})

const REPO = process.cwd()
const APP = join(REPO, 'src', 'renderer', 'src', 'App.tsx')
const CONTROLLER = join(REPO, 'src', 'renderer', 'src', 'hooks', 'useChatController.ts')
const PERSISTENCE = join(REPO, 'src', 'renderer', 'src', 'hooks', 'useConversationPersistence.ts')
const CONV_DB = join(REPO, 'src', 'main', 'storage', 'conversation.db.ts')
const SESSION_MANAGER = join(REPO, 'src', 'main', 'agent', 'session-manager.ts')
const WS_SERVER = join(REPO, 'src', 'main', 'agent', 'ws-server.ts')
const PANEL_BRIDGE = join(REPO, 'src', 'extension', 'background', 'panel-bridge.ts')
const CHANNELS = join(REPO, 'src', 'shared', 'ipc-channels.ts')
const HANDLER = join(REPO, 'src', 'main', 'ipc', 'conversation.handler.ts')
const PRELOAD = join(REPO, 'src', 'preload', 'index.ts')
const INPUT_AREA = join(REPO, 'src', 'renderer', 'src', 'components', 'chat', 'InputArea.tsx')

describe('desktop 模型 wiring (per conversation)', () => {
  const appSrc = readFileSync(APP, 'utf-8')
  const controllerSrc = readFileSync(CONTROLLER, 'utf-8')
  const persistenceSrc = readFileSync(PERSISTENCE, 'utf-8')

  it('resolves the picker through the conversation column, default last', () => {
    expect(appSrc).toContain('activeConvProfileId ?? settings.activeProfileId')
    // The welcome branch gained the sticky last-used step (新建会话沿用上次
    // 选择): the conversation the first message creates seeds it as its own
    // column, so the label matches what the first ask will run.
    expect(appSrc).toContain('pendingProfileId ?? settings.lastUsedProfileId ?? settings.activeProfileId')
  })

  it('routes the click to the conversation, or holds it for the next one', () => {
    // review_20261025 中1: the branch grew the overflow re-aim pin clear
    // (profile changed ⇒ the engine drops its re-aim, the renderer's pin must
    // go with it), so the column write no longer sits on the `if` line itself.
    // [\s\S]*? spans the inline comment between the three anchors; the order
    // is the wiring (write stays inside the activeConvKey branch).
    expect(appSrc).toMatch(/if \(activeConvKey\) \{[\s\S]*?if \(profileId !== effectiveProfileId\) clearSessionWindow\(activeConvKey\)[\s\S]*?updateConversationProfile\(activeConvKey, profileId\)/)
    expect(appSrc).toContain('usePendingProfileStore.getState().setProfileId(profileId)')
  })

  it('offers 跟随默认 only while the conversation carries its own model', () => {
    expect(appSrc).toContain('const profilePinned = activeConvKey ? activeConvProfileId != null : false')
    const inputSrc = readFileSync(INPUT_AREA, 'utf-8')
    // The model menu is grouped by 供应商 now; the reset item is built inline
    // as the trailing entry — the conditional wiring is what the scan pins.
    expect(inputSrc).toContain('profilePinned && onResetProfile ?')
    expect(inputSrc).toContain("t('chatView.model.followDefault')")
  })

  it('writes the column before the loop starts (the first ask resolves it)', () => {
    const from = controllerSrc.indexOf('const profileSeed = takePendingProfileId()')
    expect(from).toBeGreaterThan(-1)
    const to = controllerSrc.indexOf('engineHandle.startLoop(', from)
    expect(to).toBeGreaterThan(from)
  })

  it('persists through the column, the same shape as approval', () => {
    expect(persistenceSrc).toContain('partialOf(id, { profileId: profileId ?? undefined })')
    expect(persistenceSrc).toContain('window.electronAPI.setConversationProfile?.(id, profileId)')
    expect(persistenceSrc).toContain('window.electronAPI.agentSessionRefreshOptions?.(id)')
    // The sidebar list carries the choice, or a reload resets the picker.
    expect(persistenceSrc).toContain('profileId: c.profileId')
  })
})

describe('service-side 模型 resolution (pin > column > default)', () => {
  const dbSrc = readFileSync(CONV_DB, 'utf-8')
  const smSrc = readFileSync(SESSION_MANAGER, 'utf-8')
  const wsSrc = readFileSync(WS_SERVER, 'utf-8')
  const bridgeSrc = readFileSync(PANEL_BRIDGE, 'utf-8')

  it('the column has a guarded stub-insert setter and a reader', () => {
    expect(dbSrc).toContain('export function setConversationProfile(id: string, profileId: string | null): void {')
    expect(dbSrc).toContain('export function getConversationProfileId(id: string): string | undefined {')
    // Same last-line guard as the other five binding writers (counted in
    // conversation-key.test.ts).
    expect(dbSrc).toContain('stubInsertConversation(id, { profile_id: profileId })')
  })

  it('refreshOptions re-resolves the session\'s OWN model, not the bare default', () => {
    // The pre-fix shape `this.resolveProfile()` moves a pinned session onto
    // whatever the default currently is; the effective chain is the contract.
    expect(smSrc).toContain('resolveProfile(this.effectiveProfileId(sessionId, entry))')
    expect(smSrc).toContain('resolveProfile(opts.profileId ?? getConversationProfileId(sessionId))')
  })

  it('the DEFAULT switch skips sessions that own a model', () => {
    expect(smSrc).toContain('if (this.effectiveProfileId(sessionId, entry)) continue')
  })

  it('setSessionProfile writes the column and answers the model in force', () => {
    expect(smSrc).toContain('async setSessionProfile(sessionId: string, profileId: string | null): Promise<ModelState> {')
    expect(smSrc).toContain('return this.modelState(sessionId)')
  })

  it('the protocol routes a session-scoped model switch per session', () => {
    expect(wsSrc).toContain('sessions.setSessionProfile(sessionId, profileId)')
  })

  it('the panel carries a pre-session choice and replays it at session birth', () => {
    expect(bridgeSrc).toContain('await setTabModelId(tabId, msg.profileId)')
    expect(bridgeSrc).toContain('await this.applyTabModelId(tabId, created.sessionId)')
  })
})

describe('conversation:set-profile channel', () => {
  it('is registered end to end (channel → handler → preload)', () => {
    expect(readFileSync(CHANNELS, 'utf-8')).toContain("CONVERSATION_SET_PROFILE: 'conversation:set-profile'")
    expect(readFileSync(HANDLER, 'utf-8')).toContain('IPC_CHANNELS.CONVERSATION_SET_PROFILE')
    expect(readFileSync(PRELOAD, 'utf-8')).toContain('setConversationProfile:')
  })
})
