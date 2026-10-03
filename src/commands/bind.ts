// @env node
import fs from 'node:fs'
import process from 'node:process'
import { findRootSessionById, readSessionBinding, writeSessionBinding } from '../runtime/session-binding.js'

/** Explicit identity is required: cwd/mtime cannot identify a shared-server TUI. */
export function runBind(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  let cwd = process.cwd()
  let sessionId = env.CODEX_THREAD_ID
  let bindingPath: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (!['--cwd', '--session-id', '--session-binding'].includes(option) || !args[index + 1]) {
      throw new Error(`Invalid bind option: ${option}`)
    }
    const value = args[++index]
    if (option === '--cwd')
      cwd = value
    else if (option === '--session-id')
      sessionId = value
    else
      bindingPath = value
  }
  if (!bindingPath || !fs.existsSync(bindingPath)) {
    throw new Error('bind requires an existing --session-binding file.')
  }
  if (!sessionId) {
    throw new Error('bind requires --session-id or CODEX_THREAD_ID.')
  }
  const session = findRootSessionById(cwd, sessionId, env.CODEX_HOME)
  if (!session) {
    throw new Error('The requested root session was not found in this project.')
  }
  const binding = readSessionBinding(bindingPath)
  if (!binding.codexPid || binding.codexPid <= 0) {
    throw new Error('The binding has no valid Codex process; refusing to replace it.')
  }
  writeSessionBinding(bindingPath, session.path, binding.codexPid)
  process.stdout.write(`HUD bound to session ${session.sessionId}.\n`)
  return 0
}
