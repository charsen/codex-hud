import type { AccountUsageStatus } from '../codex/account-usage.js'
// @env node
import type { ParsedRolloutState } from '../codex/rollout-parser.js'
import type { CodexProcess } from '../collectors/session-metadata.js'
import type { HudConfig } from '../types/config.js'
import type { HudState, UsageData } from '../types/state.js'
import process from 'node:process'
import { selectAccountUsage } from '../codex/account-usage.js'
import { resolveUsageData } from '../codex/external-usage.js'
import { evaluateUsageTrust } from '../codex/rate-limits.js'
import { readSelectedModel } from '../codex/session-model.js'
import {
  collectAgentSnapshot,
  collectAuthInfo,
  collectGitStatus,
  collectMemoryInfo,
  collectProjectInfo,
  collectSessionTitle,
  hasTrustedOpenAiAuth,
} from '../collectors/index.js'

export function buildHudState(
  cwd: string,
  rollout: ParsedRolloutState,
  sessionStart: Date,
  config: HudConfig,
  now = new Date(),
  codexProcess: CodexProcess | null = null,
  loggedUsage: UsageData | null = null,
  queriedUsage: UsageData | null = null,
  endpoint: string | null = null,
  accountUsage: AccountUsageStatus | null = null,
): HudState {
  const workspaceRoots = rollout.session?.workspaceRoots ?? []
  const usageTrust = evaluateUsageTrust(
    endpoint,
    hasTrustedOpenAiAuth(rollout.session, process.env),
  )
  const usage = resolveUsageData(
    usageTrust.trusted ? selectAccountUsage(rollout.usage, loggedUsage, accountUsage) : null,
    config.display,
    now,
  )
  const title = config.display.showSessionName ? collectSessionTitle(rollout.session) : null
  const session = rollout.session
    ? { ...rollout.session, sessionName: title ?? rollout.session.sessionName }
    : null
  if (session && config.display.showModel) {
    session.selectedModel = readSelectedModel(session, process.env, now.getTime()) ?? undefined
  }
  const agentSnapshot = config.display.showAgents || config.display.showLastCompletedAt
    ? collectAgentSnapshot(session, process.env, now)
    : { agents: [], activity: { active: false, lastActivityAt: undefined } }
  if (session) {
    const dates = [session.lastActivityAt, session.lastCompletedAt, agentSnapshot.activity.lastActivityAt]
      .filter((date): date is Date => Boolean(date))
    session.activity = {
      active: Boolean(session.active || agentSnapshot.activity.active),
      lastActivityAt: dates.length ? new Date(Math.max(...dates.map(date => date.getTime()))) : undefined,
    }
  }
  const auth = config.display.showAuth ? collectAuthInfo(usage?.planType ?? null, session, process.env, codexProcess) : null
  return {
    session,
    project: collectProjectInfo(cwd, workspaceRoots, process.env, config.display.showConfigCounts),
    git: config.gitStatus.enabled ? collectGitStatus(cwd) : null,
    context: rollout.context,
    usage,
    sessionTokens: rollout.sessionTokens,
    tools: rollout.tools,
    images: rollout.images,
    skills: rollout.skills,
    mcpServers: rollout.mcpServers,
    agents: config.display.showAgents ? agentSnapshot.agents : [],
    todos: rollout.todos,
    goal: rollout.goal,
    conversationTurns: rollout.conversationTurns,
    compactCount: rollout.compactCount,
    memory: config.display.showMemoryUsage ? collectMemoryInfo() : null,
    auth: auth && queriedUsage?.balanceLabel ? { ...auth, balanceLabel: queriedUsage.balanceLabel } : auth,
    sessionStart: session?.startTime ?? sessionStart,
  }
}
