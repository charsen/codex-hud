import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runRenderCli } from './render-cli.js'
import { writeSessionBinding } from './runtime/session-binding.js'

let home: string
let output: string
let shutdown: (() => void) | undefined
let originalTerminationListeners: Array<(signal: 'SIGTERM') => void>

function session(name: string): string {
  const file = path.join(home, `rollout-${name}.jsonl`)
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: {
    id: name,
    cwd: home,
    source: 'cli',
    timestamp: '2026-10-03T00:00:00Z',
  } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: name } })}\n`)
  return file
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-render-binding-'))
  output = ''
  shutdown = undefined
  originalTerminationListeners = process.listeners('SIGTERM')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEX_HUD_CONFIG', path.join(home, 'config.json'))
  vi.stubEnv('TMUX_PANE', '')
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    refreshIntervalMs: 250,
    display: { showAuth: false, showUsage: false },
  }))
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})

afterEach(() => {
  shutdown?.()
  if (shutdown) {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
      process.off(signal, shutdown)
  }
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

async function start(args: string[]): Promise<void> {
  await runRenderCli(['--cwd', home, '--no-color', ...args])
  shutdown = process.listeners('SIGTERM').find(listener => !originalTerminationListeners.includes(listener)) as (() => void) | undefined
}

describe('running renderer session binding', () => {
  it('follows binding replacement and preserves it through temporary missing metadata', async () => {
    const binding = path.join(home, 'binding.json')
    const first = session('model-first')
    const second = session('model-second')
    writeSessionBinding(binding, first, 4242)
    await start(['--session-binding', binding])
    expect(output).toContain('model-first')
    output = ''
    writeSessionBinding(binding, second, 4242)
    await vi.waitFor(() => expect(output).toContain('model-second'), { timeout: 3000 })
    fs.unlinkSync(binding)
    output = ''
    // Force a changed frame; a missing binding must not discard the known thread.
    fs.appendFileSync(second, `${JSON.stringify({ type: 'turn_context', payload: { model: 'model-still-second' } })}\n`)
    await vi.waitFor(() => expect(output).toContain('model-still-second'), { timeout: 3000 })
    expect(output).not.toContain('model-first')
  })

  it('keeps an explicit --session pinned when the binding points elsewhere', async () => {
    const binding = path.join(home, 'binding.json')
    const pinned = session('model-pinned')
    writeSessionBinding(binding, session('model-foreign'), 4242)
    await start(['--session', pinned, '--session-binding', binding])
    expect(output).toContain('model-pinned')
    expect(output).not.toContain('model-foreign')
  })
})
