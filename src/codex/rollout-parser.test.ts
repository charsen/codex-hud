import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calculateContextUsage } from './context-usage.js'
import { JsonlTail } from './jsonl-tail.js'
import { redactSensitiveText, RolloutParser } from './rollout-parser.js'

const fixturePath = path.resolve('tests/fixtures/session-active.jsonl')
const currentFixturePath = path.resolve('tests/fixtures/session-active-0.153.jsonl')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('codex context usage', () => {
  it('applies the versioned 12k baseline estimate', () => {
    expect(calculateContextUsage({
      input_tokens: 70_000,
      cached_input_tokens: 50_000,
      output_tokens: 10_000,
      total_tokens: 80_000,
    }, 128_000)).toEqual({
      used: 68_000,
      total: 116_000,
      percent: 59,
      remainingPercent: 41,
      inputTokens: 20_000,
      outputTokens: 10_000,
      cachedTokens: 50_000,
    })
  })
})

describe('hud text privacy', () => {
  it('redacts common credentials before tool targets are retained', () => {
    expect(redactSensitiveText('curl -H "Authorization: Bearer secret-token" https://user:pass@example.com --api-key=sk-1234567890'))
      .toBe('curl -H "Authorization: Bearer [REDACTED]" https://[REDACTED]@example.com --api-key=[REDACTED]')
    expect(redactSensitiveText('OPENAI_API_KEY=sk-abcdefghijk PASSWORD="do-not-show"'))
      .toBe('OPENAI_API_KEY=[REDACTED] PASSWORD=[REDACTED]')
  })
})

describe('jSONL tailing', () => {
  it('retains partial lines until the newline arrives', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-jsonl-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.writeFileSync(filePath, '{"a":1}\n{"b":', 'utf8')
    const tail = new JsonlTail()
    expect(tail.read(filePath).lines).toEqual(['{"a":1}'])
    fs.appendFileSync(filePath, '2}\n', 'utf8')
    expect(tail.read(filePath).lines).toEqual(['{"b":2}'])
  })
})

describe('rollout parser', () => {
  it.each([1788647387, 1788647387000, '2026-09-05T22:29:47Z'])('accepts lifecycle timestamps in seconds, milliseconds or ISO format: %s', (value) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-lifecycle-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    const entries = [
      { type: 'session_meta', payload: { id: 'lifecycle-test' } },
      { type: 'event_msg', payload: { type: 'task_started', started_at: value } },
      { type: 'event_msg', payload: { type: 'task_complete', completed_at: value } },
    ]
    fs.writeFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
    const parser = new RolloutParser()
    parser.setFile(filePath)
    const date = new Date('2026-09-05T22:29:47Z')
    expect(parser.parse().session).toMatchObject({ lastTurnStartedAt: date, lastTurnCompletedAt: date, lastCompletedAt: date })
  })

  it('retains the last normal completion across new turns, replies, aborts and parser restarts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-completion-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    const append = (type: string, payload: object, timestamp = '2026-09-05T18:35:00Z') => {
      fs.appendFileSync(filePath, `${JSON.stringify({ type, payload, timestamp })}\n`)
    }
    append('session_meta', { id: 'completion-test', cwd: directory })
    append('event_msg', { type: 'task_started' })
    append('response_item', { type: 'message', role: 'assistant', content: [] })
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().session?.lastCompletedAt).toBeUndefined()
    expect(parser.parse().session?.active).toBe(true)
    expect(parser.parse().session?.lastActivityAt).toEqual(new Date('2026-09-05T18:35:00Z'))
    append('event_msg', { type: 'task_complete', completed_at: '2026-09-05T18:34:00Z' })
    const completed = new Date('2026-09-05T18:34:00Z')
    expect(parser.parse().session?.lastCompletedAt).toEqual(completed)
    expect(parser.parse().session?.active).toBe(false)
    append('event_msg', { type: 'task_started' }, '2026-09-06T00:00:00Z')
    append('response_item', { type: 'message', role: 'assistant', content: [] }, '2026-09-06T00:01:00Z')
    append('event_msg', { type: 'turn_aborted' }, '2026-09-06T00:02:00Z')
    expect(parser.parse().session?.lastCompletedAt).toEqual(completed)
    const restarted = new RolloutParser()
    restarted.setFile(filePath)
    expect(restarted.parse().session?.lastCompletedAt).toEqual(completed)
    append('event_msg', { type: 'task_complete' }, '2026-09-06T00:03:00Z')
    expect(parser.parse().session?.lastCompletedAt).toEqual(new Date('2026-09-06T00:03:00Z'))
  })

  it('parses representative legacy and current Codex rollout contracts', () => {
    const legacy = new RolloutParser()
    legacy.setFile(fixturePath)
    expect(legacy.parse().session?.cliVersion).toBe('0.144.1')

    const current = new RolloutParser()
    current.setFile(currentFixturePath)
    const state = current.parse()
    expect(state.session).toMatchObject({
      id: 'session-0153',
      cliVersion: '0.153.2',
      model: 'gpt-5.6-sol',
      permissionProfile: 'managed',
    })
    expect(state.usage).toMatchObject({
      primary: { label: '5h', percent: 18 },
      secondary: { label: '1w', percent: 21 },
    })
    expect(state.usageObservedAt).toEqual(new Date('2026-09-05T00:00:03.000Z'))
  })

  it('normalizes session, activity, plan, goal, tokens, and limits', () => {
    const parser = new RolloutParser()
    parser.setFile(fixturePath)
    const state = parser.parse()

    expect(state.session).toMatchObject({
      id: 'root-session',
      cwd: '/work/demo',
      cliVersion: '0.144.1',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      collaborationMode: 'default',
      lastTurnDurationMs: 10_000,
      timeToFirstTokenMs: 350,
      outputTokensPerSecond: expect.any(Number),
    })
    expect(state.context).toMatchObject({ percent: 59, remainingPercent: 41 })
    expect(state.sessionTokens).toEqual({
      inputTokens: 50_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 2_000,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 1_000,
      totalTokens: 55_000,
    })
    expect(state.usage).toMatchObject({
      primary: { label: '5h', percent: 25 },
      secondary: { label: '1w', percent: 82 },
      individual: { label: 'spend', percent: 20 },
      planType: 'pro',
      balanceLabel: '$12.50',
    })
    expect(state.tools).toHaveLength(2)
    expect(state.tools[0]).toMatchObject({ name: 'exec_command', status: 'completed' })
    expect(state.tools[1]).toMatchObject({ name: 'mcp__github__search_code', status: 'error', target: 'statusline' })
    expect(state.mcpServers).toEqual(['github'])
    expect(state.todos).toEqual([
      { content: 'Parse rollout', status: 'completed' },
      { content: 'Render HUD', status: 'in_progress' },
      { content: 'Verify', status: 'pending' },
    ])
    expect(state.goal).toEqual({
      objective: 'Build Codex HUD',
      status: 'active',
      tokenBudget: 500_000,
      tokensUsed: 12_000,
      timeUsedSeconds: 420,
    })
    expect(state.compactCount).toBe(1)
    expect(state.conversationTurns).toEqual([
      {
        id: 'turn-1',
        turnId: 'turn-1',
        startedAt: new Date('2026-07-16T08:00:01.500Z'),
        userMessage: 'Build a conversation navigator.',
        assistantMessage: 'The conversation navigator is ready.',
        assistantPhase: 'final_answer',
      },
    ])
  })

  it('parses only appended records after the initial pass', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.copyFileSync(fixturePath, filePath)
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().compactCount).toBe(1)
    fs.appendFileSync(filePath, '{"timestamp":"2026-07-16T08:01:00Z","type":"event_msg","payload":{"type":"context_compacted"}}\n')
    expect(parser.parse().compactCount).toBe(2)
  })

  it('loads conversation bodies only when the navigator asks for them', () => {
    const parser = new RolloutParser({ captureConversationBodies: false })
    parser.setFile(fixturePath)

    const lightweight = parser.parse()
    expect(lightweight.conversationTurns).toHaveLength(1)
    expect(lightweight.conversationTurns[0]).toMatchObject({ userMessage: '', assistantMessage: '' })

    parser.setConversationCapture(true)
    const detailed = parser.parse()
    expect(detailed.conversationTurns[0]).toMatchObject({
      userMessage: 'Build a conversation navigator.',
      assistantMessage: 'The conversation navigator is ready.',
    })
  })

  it('preserves complete rate-limit windows across sparse token updates', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-usage-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: { session_id: 'usage-session', cwd: directory },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 25, window_minutes: 300 },
            secondary: { used_percent: 12, window_minutes: 10_080 },
            plan_type: 'prolite',
          },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().usage).toMatchObject({
      primary: { label: '5h', percent: 25 },
      secondary: { label: '1w', percent: 12 },
      planType: 'prolite',
    })

    fs.appendFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-07-16T08:00:02Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 26, window_minutes: 300 },
          secondary: null,
          plan_type: null,
        },
      },
    })}\n`, 'utf8')
    expect(parser.parse().usage).toMatchObject({
      primary: { label: '5h', percent: 26 },
      secondary: { label: '1w', percent: 12 },
      planType: 'prolite',
    })

    fs.appendFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-07-16T08:00:03Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: null,
          secondary: null,
          plan_type: null,
        },
      },
    })}\n`, 'utf8')
    expect(parser.parse().usage).toMatchObject({
      primary: { label: '5h', percent: 26 },
      secondary: { label: '1w', percent: 12 },
      planType: 'prolite',
    })
  })

  it('updates a Pro-style weekly-only limit without losing it on an empty event', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-weekly-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:00:00Z',
        type: 'session_meta',
        payload: { session_id: 'weekly-session', cwd: directory },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:00:01Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 12, window_minutes: 10_080 },
            secondary: null,
            plan_type: 'pro',
          },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().usage).toMatchObject({
      primary: { label: '1w', percent: 12 },
      secondary: null,
      planType: 'pro',
    })

    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:01:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 13, window_minutes: 10_080 },
            secondary: null,
            plan_type: null,
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:02:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { primary: null, secondary: null, plan_type: null },
        },
      }),
      '',
    ].join('\n'), 'utf8')
    expect(parser.parse().usage).toMatchObject({
      primary: { label: '1w', percent: 13 },
      secondary: null,
      planType: 'pro',
    })
  })

  it('does not let a named model quota replace the account-wide quota', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-model-limit-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-09-05T02:50:00Z',
        type: 'session_meta',
        payload: { session_id: 'model-limit-session', cwd: directory },
      }),
      JSON.stringify({
        timestamp: '2026-09-05T02:51:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            limit_name: 'Codex',
            primary: { used_percent: 16, window_minutes: 10_080 },
            secondary: null,
            plan_type: 'prolite',
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-09-05T02:52:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 0, window_minutes: 300 },
            secondary: { used_percent: 0, window_minutes: 10_080 },
            plan_type: 'prolite',
          },
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const parser = new RolloutParser()
    parser.setFile(filePath)
    const state = parser.parse()
    expect(state.usage).toMatchObject({
      primary: { label: '1w', percent: 16 },
      secondary: null,
      planType: 'prolite',
    })
    expect(state.usageObservedAt).toEqual(new Date('2026-09-05T02:51:00Z'))
  })

  it('leaves usage empty when a rollout contains only a named model quota', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-model-only-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-09-05T02:50:00Z',
        type: 'session_meta',
        payload: { session_id: 'model-only-session', cwd: directory },
      }),
      JSON.stringify({
        timestamp: '2026-09-05T02:51:00Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 0, window_minutes: 300 },
            secondary: { used_percent: 0, window_minutes: 10_080 },
          },
        },
      }),
      '',
    ].join('\n'), 'utf8')

    const parser = new RolloutParser()
    parser.setFile(filePath)
    const state = parser.parse()
    expect(state.usage).toBeNull()
    expect(state.usageObservedAt).toBeNull()
  })

  it('records MCP servers from the event Codex actually writes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.copyFileSync(fixturePath, filePath)
    // Codex names the server in the event; only Claude Code encodes it in the
    // tool name, which the fixture already covers with mcp__github__.
    fs.appendFileSync(filePath, [
      JSON.stringify({ timestamp: '2026-07-16T08:03:00Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'node_repl', tool: 'js' } } }),
      JSON.stringify({ timestamp: '2026-07-16T08:03:01Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'node_repl', tool: 'js' } } }),
      JSON.stringify({ timestamp: '2026-07-16T08:03:02Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: '  ' } } }),
      JSON.stringify({ timestamp: '2026-07-16T08:03:03Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end' } }),
      '',
    ].join('\n'))
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().mcpServers).toEqual(['github', 'node_repl'])
  })

  it('collects existing image paths from image tool calls and outputs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-images-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    const viewed = path.join(directory, 'viewed.png')
    const generated = path.join(directory, 'generated.webp')
    fs.writeFileSync(viewed, 'png')
    fs.writeFileSync(generated, 'webp')
    fs.copyFileSync(fixturePath, filePath)
    fs.appendFileSync(filePath, [
      JSON.stringify({
        timestamp: '2026-07-16T08:04:00Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'view_image',
          call_id: 'view-1',
          arguments: JSON.stringify({ path: viewed }),
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:04:01Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'imagegen',
          call_id: 'gen-1',
          arguments: '{}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-16T08:04:02Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'gen-1',
          output: `Image saved to ${generated}`,
        },
      }),
      '',
    ].join('\n'))
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().images).toEqual([
      { path: viewed, source: 'view_image', createdAt: new Date('2026-07-16T08:04:00Z'), callId: 'view-1' },
      { path: generated, source: 'generated_image', createdAt: new Date('2026-07-16T08:04:02Z'), callId: 'gen-1' },
    ])
  })

  it('suppresses implausible output-speed samples', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-rollout-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'rollout.jsonl')
    fs.copyFileSync(fixturePath, filePath)
    fs.appendFileSync(filePath, [
      JSON.stringify({ timestamp: '2026-07-16T08:02:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fast' } }),
      JSON.stringify({ timestamp: '2026-07-16T08:02:01Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 100_000 } } } }),
      JSON.stringify({ timestamp: '2026-07-16T08:02:02Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fast', duration_ms: 1_000, time_to_first_token_ms: 100 } }),
      '',
    ].join('\n'))
    const parser = new RolloutParser()
    parser.setFile(filePath)
    expect(parser.parse().session?.outputTokensPerSecond).toBeUndefined()
  })
})
