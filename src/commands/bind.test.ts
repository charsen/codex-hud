import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessionBinding, writeSessionBinding } from '../runtime/session-binding.js'
import { runBind } from './bind.js'

let home: string
let cwd: string
let bindingPath: string

function session(id: string, project = cwd, source: unknown = 'cli'): string {
  const file = path.join(home, 'sessions', `rollout-${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {
    id,
    cwd: project,
    source,
    timestamp: '2026-10-03T00:00:00Z',
  } })}\n`)
  return file
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-bind-command-'))
  cwd = path.join(home, 'project')
  fs.mkdirSync(cwd)
  bindingPath = path.join(home, 'binding.json')
  writeSessionBinding(bindingPath, session('old'), 4242)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('explicit live HUD binding', () => {
  it('uses the tool thread identity and preserves the Codex process', () => {
    const target = session('current')
    session('newer-unrelated')
    expect(runBind(['--cwd', cwd, '--session-binding', bindingPath], {
      CODEX_HOME: home,
      CODEX_THREAD_ID: 'current',
    })).toBe(0)
    expect(readSessionBinding(bindingPath)).toEqual({ rolloutPath: target, codexPid: 4242 })
  })

  it('allows an explicit root ID to override the invoking tool thread', () => {
    const target = session('requested')
    runBind(['--cwd', cwd, '--session-binding', bindingPath, '--session-id', 'requested'], {
      CODEX_HOME: home,
      CODEX_THREAD_ID: 'other',
    })
    expect(readSessionBinding(bindingPath).rolloutPath).toBe(target)
  })

  it.each(['missing', 'foreign', 'child'])('rejects %s without changing the binding', (id) => {
    session('foreign', path.join(home, 'another-project'))
    session('child', cwd, { subagent: { thread_spawn: {} } })
    const before = fs.readFileSync(bindingPath, 'utf8')
    expect(() => runBind(['--cwd', cwd, '--session-binding', bindingPath, '--session-id', id], {
      CODEX_HOME: home,
    })).toThrow('root session was not found')
    expect(fs.readFileSync(bindingPath, 'utf8')).toBe(before)
  })

  it('rejects missing identity, missing bindings, and malformed process metadata', () => {
    expect(() => runBind(['--session-binding', bindingPath], {})).toThrow('CODEX_THREAD_ID')
    expect(() => runBind(['--session-binding', `${bindingPath}.absent`], {})).toThrow('existing')
    expect(() => runBind(['--unknown', 'value'], {})).toThrow('Invalid bind option')
    fs.writeFileSync(bindingPath, '{}')
    expect(() => runBind(['--cwd', cwd, '--session-binding', bindingPath, '--session-id', 'old'], {
      CODEX_HOME: home,
    })).toThrow('no valid Codex process')
    expect(fs.readFileSync(bindingPath, 'utf8')).toBe('{}')
  })
})
