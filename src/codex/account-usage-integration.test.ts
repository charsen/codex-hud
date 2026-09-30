import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryAccountRateLimits, refreshAccountUsage } from './account-usage.js'

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }))
})

describe('quota reader in a GUI terminal', () => {
  it.skipIf(process.platform === 'win32')('bypasses a terminal wrapper and finds Node with a minimal PATH', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-gui-quota-'))
    directories.push(home)
    const wrappers = path.join(home, 'cmux-cli-shims')
    fs.mkdirSync(wrappers)
    fs.mkdirSync(path.join(home, 'codex-hud'))
    // Taking the PATH wrapper would fail; only the managed absolute path works.
    fs.writeFileSync(path.join(wrappers, 'codex'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
    const executable = path.join(home, 'real-codex.mjs')
    fs.writeFileSync(executable, `#!/usr/bin/env node
import readline from 'node:readline'
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === 'initialize' ? {}
    : message.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : { rateLimits: { limitId: 'codex', primary: { usedPercent: 65, windowDurationMins: 10080 } } }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
})
`, { mode: 0o755 })
    fs.writeFileSync(path.join(home, 'codex-hud', 'install.json'), JSON.stringify({
      version: 2,
      realCodex: executable,
      managedFiles: [],
    }))
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: {
      account_id: 'fixture-workspace',
      access_token: 'fixture-token',
    } }))
    const result = await refreshAccountUsage('https://chatgpt.com', {
      CODEX_HOME: home,
      PATH: [wrappers, '/usr/bin', '/bin'].join(path.delimiter),
    })
    expect(result).toMatchObject({ enabled: true, failed: false, usage: { source: 'account', primary: { percent: 65 } } })
  })
})

describe('quota reader process cleanup', () => {
  it.skipIf(process.platform === 'win32')('terminates a stalled launcher and its child after allowing EOF cleanup', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-quota-tree-'))
    directories.push(home)
    fs.mkdirSync(path.join(home, 'codex-hud'))
    const childFile = path.join(home, 'server.mjs')
    const launcher = path.join(home, 'launcher.mjs')
    const pids = path.join(home, 'pids.json')
    fs.writeFileSync(childFile, `
import fs from 'node:fs'
import readline from 'node:readline'
fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.ppid, process.pid]))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.id === 0 ? {} : message.id === 1 ? { account: { type: 'chatgpt' } }
    : { rateLimits: { limitId: 'codex', primary: { usedPercent: 65 } } }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n')
})
`)
    fs.writeFileSync(launcher, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
process.on('SIGTERM', () => {})
const child = spawn(process.execPath, [${JSON.stringify(childFile)}], { stdio: 'inherit' })
child.on('exit', () => {})
setInterval(() => {}, 1000)
`, { mode: 0o755 })
    try {
      const result = await queryAccountRateLimits({
        CODEX_HOME: home,
        CODEX_HUD_CODEX_BIN: launcher,
        PATH: process.env.PATH,
      }, null)
      expect(result?.primary?.used_percent).toBe(65)
      const ids = JSON.parse(fs.readFileSync(pids, 'utf8')) as number[]
      await vi.waitFor(() => {
        for (const pid of ids) {
          expect(() => process.kill(pid, 0)).toThrow()
        }
      }, { timeout: 3000 })
    }
    finally {
      if (fs.existsSync(pids)) {
        const [pid] = JSON.parse(fs.readFileSync(pids, 'utf8')) as number[]
        try {
          process.kill(-pid, 'SIGKILL')
        }
        catch {
          // Already cleaned up.
        }
      }
    }
  }, 15000)
})
