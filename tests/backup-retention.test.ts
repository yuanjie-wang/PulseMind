import { describe, expect, it, vi } from 'vitest'
import { isExpirableBackupName, selectExpiredBackups } from '../src/main/services/backup-retention'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

const mtimeOf = (name: string): number => {
  const table: Record<string, number> = {
    'pulsemind.backup_20260811_153730.db': NOW - 40 * DAY,
    'pulsemind.db.bak_experience_dedup_20260804': NOW - 35 * DAY,
    'pulsemind.db.bak_recent': NOW - 10 * DAY,
    'pulsemind.backup_fresh.db': NOW - 2 * DAY,
    'random.db': NOW - 400 * DAY,
    'pulsemind.db': NOW - 400 * DAY,
    'pulsemind.db-wal': NOW - 400 * DAY,
    'pulsemind.db-shm': NOW - 400 * DAY,
  }
  return table[name] ?? NOW
}

describe('isExpirableBackupName — the pattern must not reach past backups', () => {
  it('hits both measured production shapes', () => {
    expect(isExpirableBackupName('pulsemind.backup_20260811_153730.db')).toBe(true)
    expect(isExpirableBackupName('pulsemind.db.bak_experience_dedup_20260804')).toBe(true)
  })

  it('never hits the live db, its siblings, or unrelated files', () => {
    for (const name of ['pulsemind.db', 'pulsemind.db-wal', 'pulsemind.db-shm', 'random.db', 'pulsemind.db.bak', 'backup_20260811.db', 'pulsemind.backup_20260811_153730.db-journal', '']) {
      expect(isExpirableBackupName(name)).toBe(false)
    }
  })
})

describe('selectExpiredBackups', () => {
  it('deletes only legal names that are past the window', () => {
    const names = Object.keys({
      'pulsemind.backup_20260811_153730.db': 1,
      'pulsemind.db.bak_experience_dedup_20260804': 1,
      'pulsemind.db.bak_recent': 1,
      'pulsemind.backup_fresh.db': 1,
      'pulsemind.db': 1,
      'pulsemind.db-wal': 1,
      random: 1,
    })
    expect(selectExpiredBackups(names, NOW, 30, mtimeOf)).toEqual([
      'pulsemind.backup_20260811_153730.db',
      'pulsemind.db.bak_experience_dedup_20260804',
    ])
  })

  it('an old-but-illegal name survives (401-day random.db is not app property)', () => {
    expect(selectExpiredBackups(['random.db', 'pulsemind.db', 'pulsemind.db-wal'], NOW, 30, mtimeOf)).toEqual([])
  })

  it('explicit 0 = keep forever — nothing is selected', () => {
    const names = ['pulsemind.backup_20260811_153730.db', 'pulsemind.db.bak_experience_dedup_20260804']
    expect(selectExpiredBackups(names, NOW, 0, mtimeOf)).toEqual([])
  })
})

describe('backupRetentionDays reader via get() (P3-a semantics)', () => {
  it('missing/invalid → 30, explicit 0 → 0 (forever), positive → floored', async () => {
    vi.resetModules()
    const { settingsStore } = await import('../src/main/storage/settings-store')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dataDir = join(process.env.HOME as string, '.pulsemind')
    const settingsPath = join(dataDir, 'settings.json')
    mkdirSync(dataDir, { recursive: true })
    const write = (raw: unknown) => writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf-8')
    const base = { activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'n', baseURL: 'https://x', model: 'm' }], theme: 'light', locale: 'zh' }
    write(base)
    expect((await settingsStore.get()).backupRetentionDays).toBe(30)
    write({ ...base, backupRetentionDays: 0 })
    expect((await settingsStore.get()).backupRetentionDays).toBe(0)
    write({ ...base, backupRetentionDays: 12.9 })
    expect((await settingsStore.get()).backupRetentionDays).toBe(12)
    write({ ...base, backupRetentionDays: 'soon' })
    expect((await settingsStore.get()).backupRetentionDays).toBe(30)
  })
})
