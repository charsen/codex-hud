// @env node
import type { SessionInfo } from '../types/state.js'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { getCodexHome } from '../config/paths.js'
import { setTimedCache } from '../runtime/timed-cache.js'

interface SelectedModel {
  model: string
  reasoningEffort?: string
  updatedAt: number
}

const cache = new Map<string, { at: number, value: SelectedModel | null }>()

/** Read the selected settings for this exact thread, independently of its running turn. */
export function readSelectedModel(session: SessionInfo, env = process.env, now = Date.now()): SelectedModel | null {
  const database = path.join(getCodexHome(env), 'state_5.sqlite')
  if (!/^[\w-]{1,128}$/.test(session.id) || !fs.existsSync(database))
    return null
  const key = `${database}:${session.id}`
  const cached = cache.get(key)
  let value = cached?.value ?? null
  if (!cached || now - cached.at >= 1_000) {
    value = null
    try {
      const result = spawnSync('sqlite3', ['-readonly', '-json', database, `SELECT model, reasoning_effort, updated_at_ms FROM threads WHERE id = '${session.id}' LIMIT 1;`], { encoding: 'utf8', timeout: 750, maxBuffer: 64 * 1024, windowsHide: true })
      if (result.status === 0) {
        const row = JSON.parse(result.stdout || '[]')[0]
        if (typeof row?.model === 'string' && row.model.trim() && Number.isFinite(row.updated_at_ms)) {
          value = {
            model: row.model,
            reasoningEffort: typeof row.reasoning_effort === 'string' ? row.reasoning_effort : undefined,
            updatedAt: row.updated_at_ms,
          }
        }
      }
    }
    catch {
      // Missing SQLite, old schemas, and unavailable databases retain rollout behavior.
    }
    setTimedCache(cache, key, { at: now, value }, 60_000, 256)
  }
  if (value && value.updatedAt >= (session.modelObservedAt?.getTime() ?? session.startTime.getTime()))
    return { ...value }
  return null
}
