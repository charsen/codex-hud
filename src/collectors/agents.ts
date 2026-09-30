import type { SessionCandidate } from '../codex/session-finder.js'
import type { AgentEntry, SessionInfo } from '../types/state.js'
// @env node
import fs from 'node:fs'
import process from 'node:process'
import { JsonlTail } from '../codex/jsonl-tail.js'
import { isSubagentSource, listSessionCandidates } from '../codex/session-finder.js'
import { getCodexHome } from '../config/paths.js'
import { pruneTimedCache, setTimedCache } from '../runtime/timed-cache.js'

const COMPLETED_VISIBLE_MS = 30_000
const STARTING_VISIBLE_MS = 15 * 60_000
const CACHE_MS = 1_000
const ROLLOUT_CACHE_MAX_AGE_MS = 60 * 60_000
const ROLLOUT_CACHE_MAX_ENTRIES = 256

interface AgentRuntime {
  entry: AgentEntry
  parentThreadId: string
  active: boolean
  visible: boolean
  lastActivityAt: Date
}

export interface AgentSnapshot {
  agents: AgentEntry[]
  activity: { active: boolean, lastActivityAt?: Date }
}

interface ParsedAgentRollout {
  active: boolean
  hasStarted: boolean
  model?: string
  startedAt: Date
  lastTimestamp: Date
}

interface AgentRolloutCache {
  at: number
  mtimeMs: number
  size: number
  tail: JsonlTail
  activeTurns: Set<string>
  hasStarted: boolean
  model?: string
  startedAt: Date
  lastTimestamp: Date
}

let cache: { key: string, at: number, snapshot: AgentSnapshot } | null = null
const rolloutCache = new Map<string, AgentRolloutCache>()

function safeDate(value: unknown, fallback: Date): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000)
    return Number.isNaN(date.getTime()) ? fallback : date
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? fallback : date
  }
  return fallback
}

function label(candidate: SessionCandidate): string {
  if (candidate.agentNickname) {
    return candidate.agentNickname
  }
  if (candidate.agentPath) {
    return candidate.agentPath.slice(candidate.agentPath.lastIndexOf('/') + 1)
  }
  if (candidate.agentRole) {
    return candidate.agentRole
  }
  return `agent-${candidate.sessionId.slice(0, 8)}`
}

function readAgentRollout(candidate: SessionCandidate): ParsedAgentRollout | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate.path)
  }
  catch {
    return null
  }
  let cached = rolloutCache.get(candidate.path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.at = Date.now()
    return {
      active: cached.activeTurns.size > 0,
      hasStarted: cached.hasStarted,
      model: cached.model,
      startedAt: new Date(cached.startedAt),
      lastTimestamp: new Date(cached.lastTimestamp),
    }
  }
  if (!cached) {
    cached = {
      at: Date.now(),
      mtimeMs: 0,
      size: 0,
      tail: new JsonlTail(),
      activeTurns: new Set<string>(),
      hasStarted: false,
      startedAt: candidate.startTime,
      lastTimestamp: candidate.startTime,
    }
  }
  try {
    const { lines, reset } = cached.tail.read(candidate.path)
    if (reset) {
      cached.activeTurns.clear()
      cached.hasStarted = false
      cached.model = undefined
      cached.startedAt = candidate.startTime
      cached.lastTimestamp = candidate.startTime
    }
    for (const line of lines) {
      let entry: { timestamp?: string, type?: string, payload?: Record<string, unknown> }
      try {
        entry = JSON.parse(line) as typeof entry
      }
      catch {
        continue
      }
      cached.lastTimestamp = safeDate(entry.timestamp, cached.lastTimestamp)
      const payload = entry.payload
      if (!payload) {
        continue
      }
      if (entry.type === 'turn_context') {
        const collaboration = payload.collaboration_mode
        const settings = collaboration && typeof collaboration === 'object' && !Array.isArray(collaboration)
          ? (collaboration as Record<string, unknown>).settings
          : null
        cached.model = typeof payload.model === 'string'
          ? payload.model
          : settings && typeof settings === 'object' && !Array.isArray(settings) && typeof (settings as Record<string, unknown>).model === 'string'
            ? (settings as Record<string, unknown>).model as string
            : cached.model
      }
      if (entry.type !== 'event_msg') {
        continue
      }
      if (payload.type === 'task_started' && typeof payload.turn_id === 'string') {
        cached.hasStarted = true
        cached.activeTurns.add(payload.turn_id)
        cached.startedAt = safeDate(payload.started_at, cached.lastTimestamp)
      }
      else if (payload.type === 'task_complete' && typeof payload.turn_id === 'string') {
        cached.hasStarted = true
        cached.activeTurns.delete(payload.turn_id)
      }
      else if (payload.type === 'turn_aborted') {
        cached.hasStarted = true
        if (typeof payload.turn_id === 'string') {
          cached.activeTurns.delete(payload.turn_id)
        }
        else {
          cached.activeTurns.clear()
        }
      }
    }
  }
  catch {
    return null
  }

  cached.at = Date.now()
  cached.mtimeMs = stat.mtimeMs
  cached.size = stat.size
  setTimedCache(rolloutCache, candidate.path, cached, ROLLOUT_CACHE_MAX_AGE_MS, ROLLOUT_CACHE_MAX_ENTRIES)
  const value: ParsedAgentRollout = {
    active: cached.activeTurns.size > 0,
    hasStarted: cached.hasStarted,
    model: cached.model,
    startedAt: cached.startedAt,
    lastTimestamp: cached.lastTimestamp,
  }
  return structuredClone(value)
}

function parseAgent(candidate: SessionCandidate, now: Date): AgentRuntime | null {
  const parsed = readAgentRollout(candidate)
  if (!parsed) {
    return null
  }
  const active = parsed.active
  const ageMs = now.getTime() - candidate.mtimeMs
  const starting = !parsed.hasStarted && !active && ageMs < STARTING_VISIBLE_MS && candidate.mtimeMs === candidate.startTime.getTime()
  return {
    parentThreadId: candidate.parentThreadId ?? '',
    active: active || starting,
    visible: active || starting || ageMs <= COMPLETED_VISIBLE_MS,
    lastActivityAt: parsed.lastTimestamp,
    entry: {
      id: candidate.sessionId,
      type: label(candidate),
      model: parsed.model,
      description: candidate.agentRole,
      path: candidate.agentPath,
      status: active ? 'running' : starting ? 'starting' : 'completed',
      startTime: parsed.startedAt,
      endTime: active || starting ? undefined : parsed.lastTimestamp,
    },
  }
}

function descendants(rootThreadId: string, runtimes: AgentRuntime[]): AgentRuntime[] {
  const visible = new Set([rootThreadId])
  const result: AgentRuntime[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const runtime of runtimes) {
      if (!visible.has(runtime.entry.id) && visible.has(runtime.parentThreadId)) {
        visible.add(runtime.entry.id)
        result.push(runtime)
        changed = true
      }
    }
  }
  return result
}

export function collectAgentSnapshot(
  session: SessionInfo | null,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): AgentSnapshot {
  if (!session) {
    return { agents: [], activity: { active: false } }
  }
  const codexHome = getCodexHome(env)
  pruneTimedCache(rolloutCache, now.getTime(), ROLLOUT_CACHE_MAX_AGE_MS, ROLLOUT_CACHE_MAX_ENTRIES)
  const key = `${codexHome}:${session.id}`
  if (cache?.key === key && now.getTime() - cache.at < CACHE_MS) {
    return structuredClone(cache.snapshot)
  }

  const candidates = listSessionCandidates(codexHome)
    .filter(candidate => isSubagentSource(candidate.source) && candidate.parentThreadId)
  // Resolve ancestry before parsing; keep completed ancestors to reach active grandchildren.
  const ids = new Set([session.id])
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of candidates) {
      if (ids.has(candidate.parentThreadId!) && !ids.has(candidate.sessionId)) {
        ids.add(candidate.sessionId)
        changed = true
      }
    }
  }
  const runtimes = candidates.filter(candidate => ids.has(candidate.sessionId))
    .flatMap((candidate) => {
      const runtime = parseAgent(candidate, now)
      return runtime ? [runtime] : []
    })
  const tree = descendants(session.id, runtimes)
  const childrenByParent = new Map<string, AgentRuntime[]>()
  for (const runtime of tree) {
    const siblings = childrenByParent.get(runtime.parentThreadId) ?? []
    siblings.push(runtime)
    childrenByParent.set(runtime.parentThreadId, siblings)
  }

  const direct = childrenByParent.get(session.id) ?? []
  const agents = direct.map((runtime) => {
    let activeDescendantCount = 0
    const queue = [...(childrenByParent.get(runtime.entry.id) ?? [])]
    while (queue.length > 0) {
      const child = queue.shift()!
      if (child.active || child.entry.status === 'starting') {
        activeDescendantCount += 1
      }
      queue.push(...(childrenByParent.get(child.entry.id) ?? []))
    }
    return runtime.visible || activeDescendantCount > 0 ? [{ ...runtime.entry, activeDescendantCount }] : []
  }).flat()
  const activity: AgentSnapshot['activity'] = { active: tree.some(runtime => runtime.active) }
  for (const runtime of tree) {
    if (!activity.lastActivityAt || runtime.lastActivityAt > activity.lastActivityAt)
      activity.lastActivityAt = runtime.lastActivityAt
  }
  const snapshot = { agents, activity }
  cache = { key, at: now.getTime(), snapshot }
  return structuredClone(snapshot)
}

export function collectAgentEntries(session: SessionInfo | null, env = process.env, now = new Date()): AgentEntry[] {
  return collectAgentSnapshot(session, env, now).agents
}
