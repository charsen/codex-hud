import type { SessionInfo } from '../types/state.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RolloutParser } from './rollout-parser.js'
import { readSelectedModel } from './session-model.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function setup(schema = 'CREATE TABLE threads (id TEXT, model TEXT, reasoning_effort TEXT, updated_at_ms INTEGER);') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-'))
  directories.push(home)
  const database = path.join(home, 'state_5.sqlite')
  const sql = (statement: string) => execFileSync('sqlite3', [database, statement])
  sql(schema)
  const session: SessionInfo = {
    id: 'thread-1',
    cwd: home,
    rolloutPath: path.join(home, 'rollout.jsonl'),
    startTime: new Date(0),
    modelObservedAt: new Date(1000),
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
  }
  return { session, sql, env: { CODEX_HOME: home } }
}

describe('selected session model', () => {
  it('refreshes settings during an unchanged turn and isolates other threads', () => {
    const { session, sql, env } = setup()
    sql('INSERT INTO threads VALUES (\'thread-1\', \'gpt-5.6-sol\', \'xhigh\', 1000), (\'thread-2\', \'other-model\', \'low\', 9000);')
    expect(readSelectedModel(session, env, 0)?.model).toBe('gpt-5.6-sol')
    sql('UPDATE threads SET model = \'gpt-6-astra\', reasoning_effort = \'high\', updated_at_ms = 2000 WHERE id = \'thread-1\';')
    expect(readSelectedModel(session, env, 1000)).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'high' })
    expect(session.model).toBe('gpt-5.6-sol')
    expect(readSelectedModel({ ...session, id: 'missing' }, env, 1000)).toBeNull()
  })

  it('ignores database settings older than the latest rollout, including cached settings', () => {
    const { session, sql, env } = setup()
    sql('INSERT INTO threads VALUES (\'thread-1\', \'old-model\', NULL, 1000);')
    expect(readSelectedModel(session, env, 0)?.model).toBe('old-model')
    session.modelObservedAt = new Date(2000)
    expect(readSelectedModel(session, env, 500)).toBeNull()
  })

  it('falls back for unsupported schemas and missing databases', () => {
    const { session, env } = setup('CREATE TABLE threads (id TEXT);')
    expect(readSelectedModel(session, env)).toBeNull()
    fs.unlinkSync(path.join(env.CODEX_HOME, 'state_5.sqlite'))
    expect(readSelectedModel(session, env)).toBeNull()
  })

  it('updates the actual model on the next turn through the same incremental parser', () => {
    const { session } = setup()
    const write = (type: string, payload: object, timestamp: number) => fs.appendFileSync(session.rolloutPath, `${JSON.stringify({ type, payload, timestamp: new Date(timestamp).toISOString() })}\n`)
    write('session_meta', { id: session.id, cwd: session.cwd }, 0)
    write('turn_context', { model: 'gpt-5.6-sol', effort: 'xhigh' }, 1000)
    const parser = new RolloutParser()
    parser.setFile(session.rolloutPath)
    expect(parser.parse().session?.model).toBe('gpt-5.6-sol')
    write('turn_context', { model: 'gpt-6-astra', effort: 'high' }, 2000)
    expect(parser.parse().session).toMatchObject({ model: 'gpt-6-astra', reasoningEffort: 'high', modelObservedAt: new Date(2000) })
  })
})
