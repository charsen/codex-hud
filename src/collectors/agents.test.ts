import type { SessionInfo } from '../types/state.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RolloutParser } from '../codex/rollout-parser.js'
import { createPreset } from '../config/presets.js'
import { buildHudState } from '../runtime/state.js'
import { collectAgentEntries, collectAgentSnapshot } from './agents.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('subagent collector', () => {
  it('updates the full task tree after one second, independently of list visibility and retention', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tree-'))
    temporaryDirectories.push(codexHome)
    vi.stubEnv('CODEX_HOME', codexHome)
    const directory = path.join(codexHome, 'sessions')
    fs.mkdirSync(directory)
    const start = Date.parse('2026-09-06T00:00:00Z')
    const write = (id: string, parent: string | null, active: boolean, time: number) => {
      const file = path.join(directory, `rollout-${id}.jsonl`)
      const entries = [
        { type: 'session_meta', payload: { id, cwd: codexHome, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : 'cli' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        ...active ? [] : [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }],
      ]
      fs.writeFileSync(file, `${entries.map(entry => JSON.stringify({ ...entry, timestamp: new Date(time).toISOString() })).join('\n')}\n`)
      fs.utimesSync(file, new Date(time), new Date(time))
      return file
    }
    const root = write('root', null, false, start)
    write('child', 'root', false, start)
    const grandchild = write('grandchild', 'child', true, start + 60_000)
    write('unrelated', 'other-root', true, start + 100_000)
    const parser = new RolloutParser()
    parser.setFile(root)
    const rollout = parser.parse()
    const session = rollout.session!
    const first = collectAgentSnapshot(session, process.env, new Date(start + 60_000))
    expect(first.activity).toEqual({ active: true, lastActivityAt: new Date(start + 60_000) })
    expect(first.agents[0]).toMatchObject({ id: 'child', activeDescendantCount: 1 })
    const config = createPreset('full')
    config.display.showAgents = false
    config.display.showAuth = false
    config.display.showModel = false
    config.gitStatus.enabled = false
    const hud = buildHudState(codexHome, rollout, new Date(start), config, new Date(start + 60_000))
    expect(hud.agents).toEqual([])
    expect(hud.session?.activity).toEqual(first.activity)
    const complete = start + 61_000
    fs.appendFileSync(grandchild, `${JSON.stringify({ timestamp: new Date(complete).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'grandchild' } })}\n`)
    fs.utimesSync(grandchild, new Date(complete), new Date(complete))
    expect(collectAgentSnapshot(session, process.env, new Date(complete)).activity).toEqual({ active: false, lastActivityAt: new Date(complete) })
    const later = collectAgentSnapshot(session, process.env, new Date(complete + 60_000))
    expect(later.agents).toEqual([])
    expect(later.activity).toEqual({ active: false, lastActivityAt: new Date(complete) })
    session.active = true
    session.lastActivityAt = new Date(complete + 65_000)
    expect(buildHudState(codexHome, rollout, new Date(start), config, new Date(complete + 65_000)).session?.activity)
      .toEqual({ active: true, lastActivityAt: session.lastActivityAt })
    vi.resetModules()
    const fresh = await import('./agents.js')
    expect(fresh.collectAgentSnapshot(session, process.env, new Date(complete + 120_000)).activity).toEqual(later.activity)
  })

  it('finds a running canonical thread-spawn child', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agents-'))
    temporaryDirectories.push(codexHome)
    const directory = path.join(codexHome, 'sessions', '2026', '07', '16')
    fs.mkdirSync(directory, { recursive: true })
    const childPath = path.join(directory, 'rollout-child.jsonl')
    fs.writeFileSync(childPath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'child',
          timestamp: '2026-07-16T08:00:00Z',
          cwd: '/work/demo',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'root',
                agent_path: '/root/explorer',
                agent_role: 'Inspect protocol',
              },
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5-mini' },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:02Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-child', started_at: '2026-07-16T08:00:02Z' },
      }),
      '',
    ].join('\n'))
    fs.utimesSync(childPath, new Date('2026-07-16T08:00:02Z'), new Date('2026-07-16T08:00:02Z'))
    const session: SessionInfo = {
      id: 'root',
      rolloutPath: '/tmp/root.jsonl',
      startTime: new Date('2026-07-16T08:00:00Z'),
      cwd: '/work/demo',
    }
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:03Z'))).toEqual([
      expect.objectContaining({
        id: 'child',
        type: 'explorer',
        model: 'gpt-5.5-mini',
        description: 'Inspect protocol',
        status: 'running',
      }),
    ])
  })

  it('incrementally applies appended completion events', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-agents-'))
    temporaryDirectories.push(codexHome)
    const directory = path.join(codexHome, 'sessions', '2026', '07', '16')
    fs.mkdirSync(directory, { recursive: true })
    const childPath = path.join(directory, 'rollout-child-incremental.jsonl')
    fs.writeFileSync(childPath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'child-incremental',
          timestamp: '2026-07-16T08:00:00Z',
          cwd: '/work/demo',
          source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-child' },
      }),
      '',
    ].join('\n'))
    const session: SessionInfo = {
      id: 'root',
      rolloutPath: '/tmp/root.jsonl',
      startTime: new Date('2026-07-16T08:00:00Z'),
      cwd: '/work/demo',
    }
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:02Z'))[0]?.status).toBe('running')
    fs.appendFileSync(childPath, `${JSON.stringify({
      timestamp: '2026-07-16T08:00:03Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-child' },
    })}\n`)
    expect(collectAgentEntries(session, { CODEX_HOME: codexHome }, new Date('2026-07-16T08:00:04Z'))[0]?.status).toBe('completed')
  })
})
