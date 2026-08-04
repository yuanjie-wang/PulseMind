import { getDb } from './database'

// Normalize ISO 8601 to SQLite-friendly "YYYY-MM-DD HH:MM:SS" for datetime functions
const NORM = "REPLACE(SUBSTR(created_at, 1, 19), 'T', ' ')"

export interface TokenStatsRow {
  label: string
  inputTokens: number
  outputTokens: number
}

export function getHourlyTokenStats(): TokenStatsRow[] {
  return getDb()
    .prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', ${NORM}, 'localtime') AS label,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM token_usage
      WHERE datetime(${NORM}) >= datetime('now', '-12 hours')
      GROUP BY strftime('%Y-%m-%d %H', ${NORM}, 'localtime')
      ORDER BY label ASC
    `)
    .all() as TokenStatsRow[]
}

export function getDailyTokenStats(): TokenStatsRow[] {
  return getDb()
    .prepare(`
      SELECT
        date(${NORM}) AS label,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM token_usage
      WHERE datetime(${NORM}) >= datetime('now', '-7 days')
      GROUP BY date(${NORM})
      ORDER BY label ASC
    `)
    .all() as TokenStatsRow[]
}

export function getMonthlyTokenStats(): TokenStatsRow[] {
  return getDb()
    .prepare(`
      SELECT
        strftime('%Y-%m', ${NORM}) AS label,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM token_usage
      WHERE datetime(${NORM}) >= datetime('now', '-6 months')
      GROUP BY strftime('%Y-%m', ${NORM})
      ORDER BY label ASC
    `)
    .all() as TokenStatsRow[]
}
