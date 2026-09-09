import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// src/main/storage/index.ts computes DATA_DIR from os.homedir() at module load,
// so HOME must point at a throwaway dir before any test file imports storage
// modules. setupFiles run before test imports — this is the only reliable hook.
process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-test-home-'))
