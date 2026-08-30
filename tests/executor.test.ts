import assert from 'node:assert/strict'
import test from 'node:test'
import { applyUnattendedPermission, pinAutomationSessionTitle, settlesWithin, summarizeRun, unattendedToolGuardReason } from '../src/executor.ts'

test('无人值守运行通过官方服务应用完整权限预设', () => {
  const selected: string[] = []
  applyUnattendedPermission({
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
    optionOf: value => ({ value, name: value }),
    set: (_session, value) => { selected.push(value) },
  }, {}, 'danger-full-access')
  assert.deepEqual(selected, ['danger-full-access'])
})

test('无人值守守卫拒绝未知工具和后台 shell', () => {
  assert.equal(unattendedToolGuardReason('read', {}), undefined)
  assert.equal(unattendedToolGuardReason('automation_create', {}), "Tool 'automation_create' is not in the unattended automation allowlist.")
  assert.match(unattendedToolGuardReason('bash', { run_in_background: true }) ?? '', /background processes/)
})

test('取消收敛等待有独立硬超时', async () => {
  assert.equal(await settlesWithin(Promise.resolve(), 10), true)
  assert.equal(await settlesWithin(new Promise(() => {}), 5), false)
})

test('运行摘要只取本 run 区间内的最后一条助手文本和 turn 结束原因', () => {
  const result = summarizeRun([
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧内容' }] } } },
    { seq: 2, type: 'turn/start', data: {} },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新结果' }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ], 2)
  assert.equal(result.text, '新结果')
  assert.equal(result.reason?.kind, 'completed')
})

test('未注入 sessionTitle 时不能让整次执行失败', () => {
  const warnings: string[] = []
  const ctx = {
    get(name: string) {
      if (name === 'sessionTitle') return undefined
      return undefined
    },
    get sessionTitle() {
      throw new Error('cannot get property "sessionTitle" without inject')
    },
    logger: { warn(message: string) { warnings.push(message) } },
  } as never
  pinAutomationSessionTitle(ctx, {}, '2026-08-17 00:36 - 每日回归检查')
  assert.deepEqual(warnings, [])
})

test('sessionTitle.rename 失败只记日志，不抛出', () => {
  const warnings: string[] = []
  const ctx = {
    get() {
      return {
        rename() { throw new Error('rename rejected') },
      }
    },
    logger: { warn(message: string) { warnings.push(message) } },
  } as never
  pinAutomationSessionTitle(ctx, {}, 'title')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /rename rejected/)
})


import { convertRunAgentToInteractive, executeAutomationRun } from '../src/executor.ts'

interface StubEvent { readonly seq: number; readonly type: string; readonly data: Record<string, any> }

function completedRunAgent() {
  const session = {
    seq: 0,
    events: [] as StubEvent[],
  }
  const agent = {
    session,
    whenIdle: async () => {},
    cancel: () => {},
    followup: () => {
      session.events.push(
        { seq: 1, type: 'turn/start', data: {} },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成' }] } } },
        { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      )
      session.seq = 3
    },
  }
  return agent
}

function integrationCtx(agent: ReturnType<typeof completedRunAgent>, hooks: {
  onGuardDisposed?: () => void
  onHandleDisposed?: () => void
} = {}) {
  return {
    logger: { warn() {} },
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    permissionPresets: { set() {} },
    agentPresets: { mount: async () => {} },
    workspaceRegistry: {
      get: () => ({
        path: '/tmp/demo',
        status: async () => 'ok',
        attachSession: async () => {},
      }),
    },
    sessions: { flush: async () => {} },
    agents: {
      withoutInitiator: (operation: () => unknown) => operation(),
      create: async (options: { setup?: (agentCtx: unknown) => Promise<void> }) => {
        await options.setup?.({
          agentPresets: { mount: async () => {} },
          agent,
          tools: { guard: () => () => hooks.onGuardDisposed?.() },
        })
        return {
          agent,
          dispose: async () => hooks.onHandleDisposed?.(),
        }
      },
    },
  } as never
}

const RUN_INPUT = {
  promptSnapshot: '检查回归',
  targetSnapshot: {
    workspaceId: 'ws_1',
    cwd: '/tmp/demo',
    agentPreset: 'standard',
    provider: 'deepseek',
    model: 'v4',
    permissionPreset: 'read-only',
  },
} as never

test('成功结束后把无人值守 Agent 转交互并移交保活，而不是 dispose', async () => {
  let guardDisposed = 0
  let handleDisposed = 0
  const kept: { id: string; handle: unknown }[] = []
  const agent = completedRunAgent()
  const completion = await executeAutomationRun(
    integrationCtx(agent, { onGuardDisposed: () => { guardDisposed += 1 }, onHandleDisposed: () => { handleDisposed += 1 } }),
    { id: 'automation_1', name: '回归任务' } as never,
    RUN_INPUT,
    {
      runTimeoutMs: 60_000,
      sessionId: 'dsh-automation-session-keep',
      keepSessionOnCompletion: true,
      onHandleKept: (id, handle) => { kept.push({ id, handle }) },
    },
  )
  assert.equal(completion.status, 'succeeded')
  assert.equal(completion.summary, '完成')
  assert.equal(kept.length, 1)
  assert.equal(kept[0]?.id, 'dsh-automation-session-keep')
  assert.equal((kept[0]?.handle as { agent: unknown }).agent, agent)
  // 转交互时解除无人值守 guard；句柄不再被执行器 dispose。
  assert.equal(guardDisposed, 1)
  assert.equal(handleDisposed, 0)
})

test('服务停止中止后仍由执行器释放句柄并登记释放标记', async () => {
  let guardDisposed = 0
  let handleDisposed = 0
  const disposedIds: string[] = []
  const controller = new AbortController()
  const agent = completedRunAgent()
  const originalFollowup = agent.followup
  agent.followup = (...args: Parameters<typeof originalFollowup>) => {
    originalFollowup(...args)
    controller.abort()
  }
  const completion = await executeAutomationRun(
    integrationCtx(agent, { onGuardDisposed: () => { guardDisposed += 1 }, onHandleDisposed: () => { handleDisposed += 1 } }),
    { id: 'automation_1', name: '回归任务' } as never,
    RUN_INPUT,
    {
      runTimeoutMs: 60_000,
      sessionId: 'dsh-automation-session-abort',
      signal: controller.signal,
      keepSessionOnCompletion: true,
      onHandleDisposed: (id) => { disposedIds.push(id) },
    },
  )
  assert.equal(completion.status, 'cancelled')
  assert.equal(handleDisposed, 1)
  assert.deepEqual(disposedIds, ['dsh-automation-session-abort'])
  // abort 路径不转交互，guard 保持到 scope 卸载。
  assert.equal(guardDisposed, 0)
})

test('convertRunAgentToInteractive 解除 guard 且容忍已卸载的 scope', () => {
  let guardCalls = 0
  const handle = { agent: { session: {} } }
  convertRunAgentToInteractive(handle, () => { guardCalls += 1 })
  assert.equal(guardCalls, 1)
  assert.doesNotThrow(() => convertRunAgentToInteractive(handle, () => { throw new Error('scope already gone') }))
  assert.doesNotThrow(() => convertRunAgentToInteractive(handle, undefined))
})
