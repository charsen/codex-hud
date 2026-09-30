import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  explicitResumeSessionId,
  installTerminationCleanup,
  isResumeInvocation,
  launchCodex,
  runCodexChild,
  waitForTmuxClient,
} from './launcher.js'
import { readSessionBinding } from './session-binding.js'

const directories: string[] = []
const originalEnv = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
  directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }))
})

function executable(directory: string, name: string, source: string): string {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, `#!/bin/sh\n${source}\n`, { mode: 0o755 })
  return filePath
}

function controlledChild(directory: string, source: string): { codex: string, finish: () => void } {
  const script = path.join(directory, 'child.mjs')
  const finished = path.join(directory, 'finished')
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    ${source}
    setInterval(() => {
      if (fs.existsSync(${JSON.stringify(finished)})) process.exit(17);
    }, 10);
  `)
  return {
    codex: executable(directory, 'codex', `exec '${process.execPath}' '${script}'`),
    finish: () => fs.writeFileSync(finished, ''),
  }
}

function fixture(tmuxSource?: string): { cwd: string, env: NodeJS.ProcessEnv, output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-launcher-'))
  directories.push(root)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const output = path.join(root, 'codex-args.txt')
  const codex = executable(bin, 'codex', `printf '%s\\n' "$@" > '${output}'; exit 23`)
  if (tmuxSource)
    executable(bin, 'tmux', tmuxSource)
  return {
    cwd: root,
    output,
    env: {
      ...process.env,
      PATH: bin,
      CODEX_HOME: path.join(root, 'codex-home'),
      CODEX_HUD_CODEX_BIN: codex,
      CMUX_SURFACE_ID: '',
      CMUX_WORKSPACE_ID: '',
      TMUX: '',
      TMUX_PANE: '',
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('non-interfering launcher', () => {
  it('cleans up once before re-delivering a termination signal', () => {
    const target = new EventEmitter() as EventEmitter & {
      pid: number
      kill: (pid: number, signal: NodeJS.Signals) => boolean
    }
    target.pid = 42
    target.kill = vi.fn(() => true)
    const cleanup = vi.fn()
    const dispose = installTerminationCleanup(cleanup, target)

    target.emit('SIGTERM')
    target.emit('SIGTERM')
    dispose()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(target.kill).toHaveBeenCalledTimes(1)
    expect(target.kill).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(target.listenerCount('SIGINT')).toBe(0)
    expect(target.listenerCount('SIGTERM')).toBe(0)
    expect(target.listenerCount('SIGHUP')).toBe(0)
  })

  it('distinguishes resume flows from ordinary new sessions', () => {
    expect(isResumeInvocation(['resume', '--last'])).toBe(true)
    expect(isResumeInvocation(['--model', 'gpt-test', 'resume', '--last'])).toBe(true)
    expect(isResumeInvocation(['Implement resume support'])).toBe(false)
    expect(isResumeInvocation([])).toBe(false)
  })

  it('waits until a real tmux client is attached before starting interactive Codex', () => {
    const states = [0, 0, 1]
    const pauses: number[] = []
    expect(waitForTmuxClient('session', 1_000, () => states.shift() ?? 1, value => pauses.push(value))).toBe(true)
    expect(pauses).toEqual([50, 50])
  })

  it('extracts only an explicit resume UUID while skipping option values', () => {
    const id = '01a0ed56-8fe3-7891-8748-c8f5e1f66c60'
    expect(explicitResumeSessionId(['resume', id, '--dangerously-bypass-approvals-and-sandbox'])).toBe(id)
    expect(explicitResumeSessionId(['--profile', 'resume', 'resume', '-i', 'image.png', id])).toBe(id)
    expect(explicitResumeSessionId(['resume', '--', id.toUpperCase()])).toBe(id)
    expect(explicitResumeSessionId(['resume', '--last'])).toBeNull()
    expect(explicitResumeSessionId(['Explain resume support'])).toBeNull()
  })

  it('binds an explicit resume before the old rollout changes and preserves cleanup', async () => {
    const { cwd, env } = fixture()
    const sessions = path.join(env.CODEX_HOME!, 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    const id = '01a0ed56-8fe3-7891-8748-c8f5e1f66c60'
    const rolloutPath = path.join(sessions, 'rollout-resumed.jsonl')
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { id, timestamp: '2026-09-29T13:24:30Z', cwd, source: 'vscode', thread_source: 'user' },
    })}\n`)
    const unchangedMtime = fs.statSync(rolloutPath).mtimeMs
    const { codex, finish } = controlledChild(cwd, '')
    env.CODEX_HUD_CODEX_BIN = codex
    const bindingPath = path.join(cwd, 'binding.json')
    const child = runCodexChild(['resume', id, '--dangerously-bypass-approvals-and-sandbox'], null, false, cwd, bindingPath, env)
    try {
      await waitFor(() => readSessionBinding(bindingPath).rolloutPath !== null, 5_000)
      expect(readSessionBinding(bindingPath).rolloutPath).toBe(rolloutPath)
      expect(fs.statSync(rolloutPath).mtimeMs).toBe(unchangedMtime)
      expect(fs.existsSync(path.join(env.CODEX_HOME!, 'codex-hud', 'bindings', 'locks'))).toBe(false)
    }
    finally {
      finish()
      expect(await child).toBe(17)
    }
    expect(fs.existsSync(bindingPath)).toBe(false)
  }, 10_000)

  it('runs official Codex directly when tmux is unavailable', async () => {
    const { cwd, env, output } = fixture()
    const result = await launchCodex({ cwd, env, codexArgs: ['--model', 'gpt-test'], height: 8, detached: false, noHud: false })
    expect(result).toMatchObject({ hudPaneId: null, sessionName: null, exitCode: 23 })
    expect(fs.readFileSync(output, 'utf8')).toBe('--model\ngpt-test\n')
  })

  it('runs official Codex directly when tmux cannot create the HUD pane', async () => {
    const { cwd, env, output } = fixture('exit 1')
    env.TMUX = '/tmp/tmux'
    env.TMUX_PANE = '%1'
    const result = await launchCodex({ cwd, env, codexArgs: ['resume', '--last'], height: 8, detached: false, noHud: false })
    expect(result.exitCode).toBe(23)
    expect(result.hudPaneId).toBeNull()
    expect(fs.readFileSync(output, 'utf8')).toBe('resume\n--last\n')
  })

  it('uses a launch-private tmux socket outside an existing tmux session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-private-tmux-'))
    directories.push(root)
    const log = path.join(root, 'tmux-args.txt')
    const { cwd, env } = fixture([
      `printf '%s\\n' "$*" >> '${log}'`,
      `case " $* " in *" split-window "*) printf '%%2\\n' ;; esac`,
      'exit 0',
    ].join('\n'))
    env.CODEX_HOME = path.join(root, 'codex-home')

    const launched = await launchCodex({ cwd, env, codexArgs: [], height: 8, detached: true, noHud: false })
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(launched.socketPath).toMatch(/codex-home\/codex-hud\/tmux\/.+\.sock$/)
    expect(fs.statSync(path.dirname(launched.socketPath!)).mode & 0o777).toBe(0o700)
    expect(calls.every(call => call.startsWith(`-S ${launched.socketPath} `))).toBe(true)
    expect(calls.some(call => call.includes(`-f ${os.devNull} new-session`))).toBe(true)
    expect(calls.some(call => call.includes('has-session'))).toBe(false)
  })

  it('uses a native cmux split without wrapping Codex in tmux', async () => {
    const { cwd, env, output } = fixture()
    const log = path.join(cwd, 'cmux-args.txt')
    executable(path.join(cwd, 'bin'), 'cmux', [
      `printf '%s\n' "$*" >> '${log}'`,
      `case " $* " in *" identify "*) printf '%s\n' '{"caller":{"pane_id":"source-pane-id"}}' ;; esac`,
      `case " $* " in *" new-split "*) printf '%s\n' '{"workspace_id":"workspace-id","pane_id":"pane-id","surface_id":"surface-id"}' ;; esac`,
      'exit 0',
    ].join('\n'))
    env.CMUX_WORKSPACE_ID = 'workspace-id'
    env.CMUX_SURFACE_ID = 'source-surface-id'

    const launched = await launchCodex({
      cwd,
      env,
      codexArgs: [],
      height: 8,
      detached: false,
      noHud: false,
    })

    expect(launched).toMatchObject({ backend: 'cmux', cmuxSurfaceId: 'surface-id', exitCode: 23 })
    expect(fs.readFileSync(output, 'utf8')).toBe('\n')
    const calls = fs.readFileSync(log, 'utf8')
    expect(calls).toContain('ping')
    expect(calls).toContain('identify --workspace workspace-id --surface source-surface-id')
    expect(calls).toContain('new-split down')
    expect(calls).toContain('resize-pane --workspace workspace-id --pane source-pane-id -D --amount 10000')
    expect(calls).toContain('send --workspace workspace-id --surface surface-id')
    expect(calls).toContain('close-surface --workspace workspace-id --surface surface-id')
    expect(calls).not.toContain('tmux')
  })

  it('keeps Codex native when the cmux control socket is unavailable', async () => {
    const { cwd, env, output } = fixture()
    const tmuxMarker = path.join(cwd, 'tmux-used.txt')
    executable(path.join(cwd, 'bin'), 'tmux', `printf 'tmux-used\n' >> '${tmuxMarker}'`)
    executable(path.join(cwd, 'bin'), 'cmux', 'exit 1')
    env.CMUX_WORKSPACE_ID = 'workspace-id'
    env.CMUX_SURFACE_ID = 'surface-id'

    const launched = await launchCodex({
      cwd,
      env,
      codexArgs: [],
      height: 8,
      detached: false,
      noHud: false,
    })

    expect(launched.backend).toBe('none')
    expect(launched.exitCode).toBe(23)
    expect(fs.readFileSync(output, 'utf8')).toBe('\n')
    expect(fs.existsSync(tmuxMarker)).toBe(false)
  })

  it('falls back to official Codex when the private tmux socket cannot be created', async () => {
    const { cwd, env, output } = fixture('exit 0')
    const blockedHome = path.join(cwd, 'blocked-codex-home')
    fs.writeFileSync(blockedHome, 'not a directory')
    env.CODEX_HOME = blockedHome

    const launched = await launchCodex({
      cwd,
      env,
      codexArgs: ['resume', '--last'],
      height: 8,
      detached: false,
      noHud: false,
    })

    expect(launched).toMatchObject({ socketPath: null, exitCode: 23 })
    expect(fs.readFileSync(output, 'utf8')).toBe('resume\n--last\n')
  })

  it('binds the child to the rollout created by that Codex process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-child-'))
    directories.push(root)
    const cwd = path.join(root, 'project')
    const codexHome = path.join(root, 'codex-home')
    const sessions = path.join(codexHome, 'sessions', '2026', '07', '17')
    const bindingPath = path.join(root, 'binding.json')
    fs.mkdirSync(cwd)
    fs.mkdirSync(sessions, { recursive: true })
    const rolloutPath = path.join(sessions, 'rollout-owned.jsonl')
    const { codex, finish } = controlledChild(root, `
      fs.writeFileSync(${JSON.stringify(rolloutPath)}, JSON.stringify({
        type: 'session_meta', payload: { id: 'owned', timestamp: new Date().toISOString(), cwd: ${JSON.stringify(cwd)}, source: 'cli' }
      }) + '\\n');
    `)
    process.env.CODEX_HOME = codexHome
    process.env.CODEX_HUD_CODEX_BIN = codex

    const child = runCodexChild([], null, false, cwd, bindingPath)
    try {
      await waitFor(() => readSessionBinding(bindingPath).rolloutPath !== null, 5_000)
      expect(readSessionBinding(bindingPath).rolloutPath).toBe(rolloutPath)
      expect(readSessionBinding(bindingPath).codexPid).toBeGreaterThan(0)
    }
    finally {
      finish()
      expect(await child).toBe(17)
    }
    expect(readSessionBinding(bindingPath).rolloutPath).toBeNull()
  }, 10_000)

  it('binds a delayed app-server rollout before the child exits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-delayed-child-'))
    directories.push(root)
    const cwd = path.join(root, 'project')
    const codexHome = path.join(root, 'codex-home')
    const sessions = path.join(codexHome, 'sessions', '2026', '07', '17')
    const bindingPath = path.join(root, 'binding.json')
    fs.mkdirSync(cwd)
    fs.mkdirSync(sessions, { recursive: true })
    const metadata = (id: string) => JSON.stringify({
      type: 'session_meta',
      payload: { id, timestamp: new Date().toISOString(), cwd, thread_source: 'user', source: 'vscode' },
    })
    fs.writeFileSync(path.join(sessions, 'rollout-existing.jsonl'), `${metadata('existing')}\n`)
    const rolloutPath = path.join(sessions, 'rollout-delayed.jsonl')
    const { codex, finish } = controlledChild(root, `
      const started = new Date().toISOString();
      setTimeout(() => fs.writeFileSync(${JSON.stringify(rolloutPath)}, JSON.stringify({
        type: 'session_meta', payload: { id: 'delayed', timestamp: started, cwd: ${JSON.stringify(cwd)}, thread_source: 'user', source: 'vscode' }
      }) + '\\n'), 1_500);
    `)
    process.env.CODEX_HOME = codexHome
    process.env.CODEX_HUD_CODEX_BIN = codex

    const child = runCodexChild([], null, false, cwd, bindingPath)
    try {
      await waitFor(() => readSessionBinding(bindingPath).rolloutPath !== null, 5_000)
      expect(readSessionBinding(bindingPath).rolloutPath).toBe(rolloutPath)
      expect(readSessionBinding(bindingPath).codexPid).toBeGreaterThan(0)
    }
    finally {
      finish()
      expect(await child).toBe(17)
    }
    expect(readSessionBinding(bindingPath).rolloutPath).toBeNull()
  }, 10_000)

  it('binds a first-message rollout after the startup window without borrowing a later launch', async () => {
    const { cwd, env } = fixture()
    const sessions = path.join(env.CODEX_HOME!, 'sessions')
    const bindingPath = path.join(cwd, 'binding.json')
    const rolloutPath = path.join(sessions, 'rollout-owned.jsonl')
    fs.mkdirSync(sessions, { recursive: true })
    const { codex, finish } = controlledChild(cwd, `
      const started = new Date().toISOString();
      const write = (name, timestamp) => fs.writeFileSync(${JSON.stringify(sessions)} + '/rollout-' + name + '.jsonl', JSON.stringify({
        type: 'session_meta', payload: { id: name, timestamp, cwd: ${JSON.stringify(cwd)}, source: 'vscode', thread_source: 'user' }
      }) + '\\n');
      setTimeout(() => write('later-launch', new Date().toISOString()), 11_000);
      setTimeout(() => write('owned', started), 12_000);
    `)
    env.CODEX_HUD_CODEX_BIN = codex
    const child = runCodexChild([], null, false, cwd, bindingPath, env)
    try {
      await waitFor(() => readSessionBinding(bindingPath).rolloutPath !== null, 15_000)
      expect(readSessionBinding(bindingPath).rolloutPath).toBe(rolloutPath)
      const locks = path.join(env.CODEX_HOME!, 'codex-hud', 'bindings', 'locks')
      expect(fs.readdirSync(locks)).toEqual([])
    }
    finally {
      finish()
      expect(await child).toBe(17)
    }
    expect(fs.existsSync(bindingPath)).toBe(false)
  }, 18_000)

  it('returns the child exit code when Codex exits before creating a rollout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-child-'))
    directories.push(root)
    const cwd = path.join(root, 'project')
    const codexHome = path.join(root, 'codex-home')
    const bindingPath = path.join(root, 'binding.json')
    fs.mkdirSync(cwd)
    const codex = executable(root, 'codex', 'exit 29')
    process.env.CODEX_HOME = codexHome
    process.env.CODEX_HUD_CODEX_BIN = codex
    expect(await runCodexChild([], null, false, cwd, bindingPath)).toBe(29)
  })
})
