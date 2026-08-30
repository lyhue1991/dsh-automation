import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefinition } from '../src/domain.ts'
import { AutomationService, type AutomationConfig } from '../src/service.ts'
import type { AutomationDefinition, AutomationRun } from '../src/types.ts'

const permissionPresets = {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  defaultPreset: 'workspace-write',
  optionOf: (value: string) => ({ value, name: value }),
  set() {},
}

class MemoryTable<V> {
  private readonly values = new Map<string, V>()
  beforeMutation?: (kind: 'put' | 'update', key: string) => Promise<void>
  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return this.values.entries() }
  keys(): IterableIterator<string> { return this.values.keys() }
  get size(): number { return this.values.size }
  setNow(key: string, value: V): void { this.values.set(key, value) }
  async put(key: string, value: V): Promise<void> {
    await this.beforeMutation?.('put', key)
    this.values.set(key, value)
  }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
  async update(key: string, transform: (current: V) => V): Promise<V> {
    await this.beforeMutation?.('update', key)
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`missing ${key}`)
    const next = transform(current)
    this.values.set(key, next)
    return next
  }
}

function config(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    maxConcurrentRuns: 2,
    runTimeoutMs: 60_000,
    misfireGraceMs: 15 * 60_000,
    historyLimit: 3,
    liveSessionLimit: 2,
    ...overrides,
  }
}

function makeService(initial: {
  definitions?: AutomationDefinition[]
  runs?: AutomationRun[]
} = {}, overrides: Partial<AutomationConfig> = {}, ctxOverrides: Record<string, unknown> = {}) {
  const definitions = new MemoryTable<AutomationDefinition>()
  const runs = new MemoryTable<AutomationRun>()
  for (const item of initial.definitions ?? []) void definitions.put(item.id, item)
  for (const item of initial.runs ?? []) void runs.put(item.id, item)
  const agent = {
    session: {
      header: { cwd: 'D:\\work\\demo', agentPreset: 'standard' },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
    },
    ctx: {},
  }
  const ctx = {
    permissionPresets,
    logger: { warn() {} },
    storageDomain: {
      async open() {
        return {
          name: 'dsh_automation',
          table(name: string) { return name === 'definitions' ? definitions : runs },
          async close() {},
        }
      },
    },
    agents: {
      get() { return agent },
    },
    workspaceRegistry: {
      get(id: unknown) {
        return String(id) === 'ws_1' ? { id: 'ws_1', title: 'demo', path: 'D:\\work\\demo' } : undefined
      },
      async resolveByPath(path: string) {
        return path === 'D:\\work\\demo'
          ? { id: 'ws_1', title: 'demo', path: 'D:\\work\\demo' }
          : undefined
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    agentPresets: { composedPreset: () => 'standard' },
    ...ctxOverrides,
  }
  return AutomationService.open(ctx as never, config(overrides)).then(async (service) => {
    Object.assign(service as any, { definitions, runs })
    return { service, definitions, runs }
  })
}

function sampleDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return createDefinition({
    id: 'automation_1',
    name: '每日检查',
    prompt: '检查测试',
    schedule: { kind: 'once', at: '2026-08-16T01:00:00.000Z', timeZone: 'UTC' },
    workspaceId: 'ws_1',
    cwd: 'D:\\work\\demo',
    agentPreset: 'standard',
    createdBy: { kind: 'web', sessionId: 'session_1' },
    now: '2026-08-16T00:00:00.000Z',
    ...overrides,
  })
}

test('重启后把遗留 queued/running 标记为 host_interrupted', async () => {
  const definition = sampleDefinition()
  const { runs } = await makeService({
    definitions: [definition],
    runs: [{
      version: 1,
      id: 'run_old',
      automationId: definition.id,
      definitionRevision: 1,
      occurrenceKey: 'k',
      trigger: 'schedule',
      scheduledFor: '2026-08-16T00:30:00.000Z',
      status: 'running',
      promptSnapshot: definition.prompt,
      targetSnapshot: {
        workspaceId: definition.workspaceId,
        cwd: definition.cwd,
        agentPreset: definition.agentPreset,
        provider: null,
        model: null,
        permissionPreset: 'read-only',
      },
      sessionId: 'sess',
      startedAt: '2026-08-16T00:30:00.000Z',
      finishedAt: null,
      summary: null,
      error: null,
      unread: true,
    }],
  })
  const recovered = runs.get('run_old')
  assert.equal(recovered?.status, 'failed')
  assert.equal(recovered?.error?.code, 'host_interrupted')
})

test('ownsSession 通过前缀、运行记录和消息来源识别自动化会话', async () => {
  const { service } = await makeService()
  assert.equal(service.ownsSession('dsh-automation-session-abc'), true)
  assert.equal(service.ownsSession('user-session', [
    { type: 'user/message', data: { source: { kind: 'automation' } } },
  ]), true)
  assert.equal(service.ownsSession('user-session', [
    { type: 'user/message', data: { source: { kind: 'user' } } },
  ]), false)
})

test('创建和立即运行都限制在来源工作区', async () => {
  const { service } = await makeService()
  const created = await service.create({ sessionId: 'session_1', creatorKind: 'web' }, {
    name: '一次性',
    prompt: '跑测试',
    schedule: { kind: 'once', at: '2099-01-01T10:00:00.000Z', timeZone: 'UTC' },
  })
  assert.equal(created.workspaceId, 'ws_1')
  const run = await service.runNow({ sessionId: 'session_1', creatorKind: 'web' }, created.id)
  assert.equal(run.trigger, 'manual')
  await assert.rejects(
    () => service.runNow({ sessionId: 'session_1', creatorKind: 'web' }, created.id),
    /queued or running/,
  )
})

test('权限列表、默认值和校验均来自 Host 官方服务', async () => {
  const { service } = await makeService()
  const snapshot = await service.snapshot({ sessionId: 'session_1', creatorKind: 'web', hostWide: true })
  assert.deepEqual(snapshot.permissions.map(item => item.value), permissionPresets.names)
  assert.equal(snapshot.defaultPermission, 'workspace-write')
  const created = await service.create({ sessionId: 'session_1', creatorKind: 'web' }, {
    name: '官方默认权限',
    prompt: '检查状态',
    schedule: { kind: 'once', at: '2099-01-01T10:00:00.000Z', timeZone: 'UTC' },
  })
  assert.equal(created.permissionPreset, 'workspace-write')
  await assert.rejects(() => service.update(
    { sessionId: 'session_1', creatorKind: 'web' },
    created.id,
    { permissionPreset: 'not-official' },
  ), /unknown permission preset/)
})

test('启动时把旧 full-access 迁移成官方 danger-full-access', async () => {
  const legacy = sampleDefinition({ permissionPreset: 'full-access' })
  const { definitions } = await makeService({ definitions: [legacy] })
  assert.equal(definitions.get(legacy.id)?.permissionPreset, 'danger-full-access')
})

test('服务端接受 Host 官方完全访问权限', async () => {
  const { service } = await makeService()
  const created = await service.create({ sessionId: 'session_1', creatorKind: 'web' }, {
    name: '危险任务',
    prompt: '修改任意文件',
    schedule: { kind: 'once', at: '2099-01-01T10:00:00.000Z', timeZone: 'UTC' },
    permissionPreset: 'danger-full-access',
  })
  assert.equal(created.permissionPreset, 'danger-full-access')
})

test('编辑已到期 once 的非计划字段时允许保留原时间', async () => {
  const definition = sampleDefinition()
  const { service } = await makeService({ definitions: [definition] })
  const updated = await service.update(
    { sessionId: 'session_1', creatorKind: 'web', hostWide: true },
    definition.id,
    { name: '改名后', schedule: definition.schedule },
  )
  assert.equal(updated.name, '改名后')
  await assert.rejects(() => service.update(
    { sessionId: 'session_1', creatorKind: 'web', hostWide: true },
    definition.id,
    { schedule: { kind: 'once', at: '2026-08-17T01:00:00.000Z', timeZone: 'UTC' } },
  ), /must be scheduled at a future time/)
})

test('更新工作区时必须由 id 和路径解析到同一个注册目录', async () => {
  const definition = sampleDefinition()
  const { service } = await makeService({ definitions: [definition] })
  await assert.rejects(() => service.update(
    { sessionId: 'session_1', creatorKind: 'web', hostWide: true },
    definition.id,
    { workspaceId: 'ws_1', cwd: 'D:\\other' },
  ), /same registered directory/)
})

test('创建工作区时 id 和路径也必须解析到同一个注册目录', async () => {
  const { service } = await makeService()
  const scope = { sessionId: 'session_1', creatorKind: 'web' as const, hostWide: true }
  const request = {
    name: '工作区检查',
    prompt: '检查状态',
    schedule: { kind: 'once' as const, at: '2099-01-01T10:00:00.000Z', timeZone: 'UTC' },
  }
  await assert.rejects(() => service.create(scope, {
    ...request,
    workspaceId: 'missing',
    cwd: 'D:\\work\\demo',
  }), /same registered directory/)
  await assert.rejects(() => service.create(scope, {
    ...request,
    workspaceId: 'ws_1',
    cwd: 'D:\\other',
  }), /same registered directory/)
  const byId = await service.create(scope, { ...request, name: '仅 ID', workspaceId: 'ws_1' })
  const byPath = await service.create(scope, { ...request, name: '仅目录', cwd: 'D:\\work\\demo' })
  assert.equal(byId.workspaceId, 'ws_1')
  assert.equal(byId.cwd, 'D:\\work\\demo')
  assert.equal(byPath.workspaceId, 'ws_1')
  assert.equal(byPath.cwd, 'D:\\work\\demo')
})

test('连续 snapshot 在短 TTL 内复用模型和技能目录结果', async () => {
  let listModelsCalls = 0
  let resolveCalls = 0
  const { service } = await makeService({}, {}, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      async listModels() {
        listModelsCalls += 1
        return [{ id: 'v4', name: 'V4' }]
      },
      async resolveModelInfo() {
        resolveCalls += 1
        return {}
      },
    },
  })
  const scope = { sessionId: 'session_1', creatorKind: 'web' as const, hostWide: true }
  await service.snapshot(scope)
  await service.snapshot(scope)
  assert.equal(listModelsCalls, 1)
  assert.equal(resolveCalls, 1)
})




test('forgetSession 会摘掉已删除 Session，但保留运行历史', async () => {
  const definition = sampleDefinition()
  const { service, runs } = await makeService({
    definitions: [definition],
    runs: [{
      version: 1,
      id: 'run_keep',
      automationId: definition.id,
      definitionRevision: 1,
      occurrenceKey: 'k2',
      trigger: 'schedule',
      scheduledFor: '2026-08-16T00:30:00.000Z',
      status: 'succeeded',
      promptSnapshot: definition.prompt,
      targetSnapshot: {
        workspaceId: definition.workspaceId,
        cwd: definition.cwd,
        agentPreset: definition.agentPreset,
        provider: null,
        model: null,
        permissionPreset: 'read-only',
      },
      sessionId: 'dead-session',
      startedAt: '2026-08-16T00:30:00.000Z',
      finishedAt: '2026-08-16T00:31:00.000Z',
      summary: 'ok',
      error: null,
      unread: false,
    }],
  })
  await service.forgetSession('dead-session')
  const kept = runs.get('run_keep')
  assert.equal(kept?.status, 'succeeded')
  assert.equal(kept?.sessionId, null)
})

test('持久化日志仍存在时，Agent 释放事件不会摘掉历史会话链接', async () => {
  const definition = sampleDefinition()
  const run: AutomationRun = {
    version: 1,
    id: 'run_persisted',
    automationId: definition.id,
    definitionRevision: 1,
    occurrenceKey: 'persisted',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'succeeded',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: null,
      model: null,
      permissionPreset: 'read-only',
    },
    sessionId: 'persisted-session',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    error: null,
    unread: false,
  }
  const { service, runs } = await makeService({ definitions: [definition], runs: [run] }, {}, {
    sessions: { list: () => [] },
    sessionPersistence: { list: async () => [{ id: 'persisted-session' }] },
  })
  await service.forgetSession('persisted-session')
  assert.equal(runs.get(run.id)?.sessionId, 'persisted-session')
})

test('打开历史自动化会话时通过 resume 创建并复用用户 Agent', async () => {
  const definition = sampleDefinition()
  const run: AutomationRun = {
    version: 1,
    id: 'run_resume',
    automationId: definition.id,
    definitionRevision: 1,
    occurrenceKey: 'resume',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'succeeded',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: 'deepseek',
      model: 'v4',
      permissionPreset: 'read-only',
    },
    sessionId: 'resume-session',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    error: null,
    unread: false,
  }
  let resumeCalls = 0
  let mountedPreset = ''
  let disposed = 0
  let ownerDisposed = 0
  const resumeOwnerAgents = {
    withoutInitiator: async (operation: () => Promise<unknown>) => operation(),
    async resume(options: { readonly resumeSessionId: string; readonly agentOptions: { readonly provider: string; readonly model: string }; readonly setup?: (ctx: unknown) => Promise<void> }) {
      resumeCalls += 1
      assert.equal(options.resumeSessionId, 'resume-session')
      assert.deepEqual(options.agentOptions, { provider: 'deepseek', model: 'v4' })
      const session = { header: { cwd: definition.cwd }, events: [] }
      await options.setup?.({
        agent: { session },
      } as never)
      return { agent: { session }, async dispose() { disposed += 1 } }
    },
  }
  const { service } = await makeService({ definitions: [definition], runs: [run] }, {}, {
    agents: { get: () => undefined },
    plugin: () => ({
      ctx: { agents: resumeOwnerAgents },
      async dispose() { ownerDisposed += 1 },
    }),
    agentPresets: { mount: async (_ctx: unknown, preset: string) => { mountedPreset = preset }, composedPreset: () => 'standard' },
  })
  assert.equal(await service.resumeSession('resume-session'), true)
  assert.equal(await service.resumeSession('resume-session'), true)
  assert.equal(resumeCalls, 1)
  assert.equal(mountedPreset, 'standard')
  // A delayed disposal event from the old automation handle must not tear
  // down the freshly resumed user Agent.
  const internals = service as unknown as { readonly releasedSessionEvents: Set<string> }
  internals.releasedSessionEvents.add('resume-session')
  await service.forgetSession('resume-session')
  assert.equal(disposed, 0)
  await service.dispose()
  assert.equal(disposed, 1)
  assert.equal(ownerDisposed, 1)
})

test('forgetSession 与运行完成并发时不会把终态覆盖回 running', async () => {
  const definition = sampleDefinition()
  const running: AutomationRun = {
    version: 1,
    id: 'run_race_forget',
    automationId: definition.id,
    definitionRevision: 1,
    occurrenceKey: 'race-forget',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'running',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: null,
      model: null,
      permissionPreset: 'read-only',
    },
    sessionId: 'dead-session',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: null,
    summary: null,
    error: null,
    unread: false,
  }
  const { service, runs } = await makeService({ definitions: [definition], runs: [running] })
  runs.setNow(running.id, running)
  let release!: () => void
  let mutationStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { mutationStarted = resolve })
  let blocked = false
  runs.beforeMutation = async (_kind, key) => {
    if (key !== running.id || blocked) return
    blocked = true
    mutationStarted()
    await gate
  }

  const forgetting = service.forgetSession('dead-session')
  await started
  runs.setNow(running.id, {
    ...running,
    status: 'succeeded',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    unread: true,
  })
  release()
  await forgetting

  const completed = runs.get(running.id)
  assert.equal(completed?.status, 'succeeded')
  assert.equal(completed?.summary, 'ok')
  assert.equal(completed?.sessionId, null)
})

test('删除定义与运行完成并发时只更新历史任务名', async () => {
  const definition = sampleDefinition({ name: '当前任务名' })
  const running: AutomationRun = {
    version: 1,
    id: 'run_race_delete',
    automationId: definition.id,
    automationName: '旧任务名',
    definitionRevision: 1,
    occurrenceKey: 'race-delete',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'running',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: null,
      model: null,
      permissionPreset: 'read-only',
    },
    sessionId: 'live-session',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: null,
    summary: null,
    error: null,
    unread: false,
  }
  const { service, runs } = await makeService({ definitions: [definition], runs: [running] })
  runs.setNow(running.id, running)
  let release!: () => void
  let mutationStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { mutationStarted = resolve })
  let blocked = false
  runs.beforeMutation = async (_kind, key) => {
    if (key !== running.id || blocked) return
    blocked = true
    mutationStarted()
    await gate
  }

  const deleting = service.delete({ sessionId: 'session_1', creatorKind: 'web', hostWide: true }, definition.id)
  await started
  runs.setNow(running.id, {
    ...running,
    status: 'succeeded',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    unread: true,
  })
  release()
  await deleting

  const completed = runs.get(running.id)
  assert.equal(completed?.status, 'succeeded')
  assert.equal(completed?.summary, 'ok')
  assert.equal(completed?.automationName, '当前任务名')
})

test('启动时对宿主已不存在的 Session 摘掉 run.sessionId', async () => {
  const definition = sampleDefinition()
  const definitions = new MemoryTable<AutomationDefinition>()
  const runs = new MemoryTable<AutomationRun>()
  await definitions.put(definition.id, definition)
  await runs.put('run_ghost', {
    version: 1,
    id: 'run_ghost',
    automationId: definition.id,
    definitionRevision: 1,
    occurrenceKey: 'k3',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'succeeded',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: null,
      model: null,
      permissionPreset: 'read-only',
    },
    sessionId: 'ghost',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    error: null,
    unread: false,
  })
  const ctx = {
    permissionPresets,
    logger: { warn() {} },
    get(name: string) { return name === 'sessionPersistence' ? { async list() { return [{ id: 'other' }] } } : undefined },
    sessions: { list() { return [] } },
    storageDomain: {
      async open() {
        return {
          name: 'dsh_automation',
          table(name: string) { return name === 'definitions' ? definitions : runs },
          async close() {},
        }
      },
    },
    agents: { get() { return { session: { header: {}, requestHeader: () => ({ config: {} }) }, ctx: {} } } },
    workspaceRegistry: { async resolveByPath() { return { id: 'ws_1', title: 'demo', path: 'D:\\work\\demo' } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    agentPresets: { composedPreset: () => 'standard' },
  }
  const service = await AutomationService.open(ctx as never, config())
  Object.assign(service, { definitions, runs })
  const ghost = runs.get('run_ghost')
  assert.equal(ghost?.status, 'succeeded')
  assert.equal(ghost?.sessionId, null)
})

test('forgetSession 释放保活句柄并摘掉运行记录的 sessionId', async () => {
  const definition = sampleDefinition()
  const run: AutomationRun = {
    version: 1,
    id: 'run_kept',
    automationId: definition.id,
    definitionRevision: 1,
    occurrenceKey: 'kept',
    trigger: 'schedule',
    scheduledFor: '2026-08-16T00:30:00.000Z',
    status: 'succeeded',
    promptSnapshot: definition.prompt,
    targetSnapshot: {
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      agentPreset: definition.agentPreset,
      provider: 'deepseek',
      model: 'v4',
      permissionPreset: 'read-only',
    },
    sessionId: 'kept-session',
    startedAt: '2026-08-16T00:30:00.000Z',
    finishedAt: '2026-08-16T00:31:00.000Z',
    summary: 'ok',
    error: null,
    unread: false,
  }
  const { service } = await makeService({ definitions: [definition], runs: [run] })
  let disposed = 0
  const kept = (service as unknown as { kept: Map<string, unknown> }).kept
  kept.set('kept-session', {
    agent: { status: 'idle', session: { header: { cwd: definition.cwd } } },
    async dispose() { disposed += 1 },
  })
  await service.forgetSession('kept-session')
  assert.equal(disposed, 1)
  assert.equal(kept.has('kept-session'), false)
  await service.dispose()
})

test('超出 liveSessionLimit 时按完成顺序回收保活会话并跳过运行中的会话', async () => {
  const { service } = await makeService({}, { liveSessionLimit: 2 })
  const disposed: string[] = []
  const makeHandle = (id: string, status: 'idle' | 'running') => ({
    agent: { status, session: { header: { cwd: 'D:\\work\\demo' } } },
    async dispose() { disposed.push(id) },
  })
  const internals = service as unknown as {
    kept: Map<string, ReturnType<typeof makeHandle>>
    releasedSessionEvents: Set<string>
    evictKeptSessions(): void
  }
  internals.kept.set('s1', makeHandle('s1', 'idle'))
  internals.kept.set('s2', makeHandle('s2', 'idle'))
  internals.kept.set('s3', makeHandle('s3', 'running'))
  internals.kept.set('s4', makeHandle('s4', 'idle'))
  internals.evictKeptSessions()
  // running 的 s3 不能被驱逐；从 4 个收到上限 2 个必须依次回收 s1、s2。
  assert.deepEqual(disposed, ['s1', 's2'])
  assert.deepEqual([...internals.kept.keys()], ['s3', 's4'])
  assert.equal(internals.releasedSessionEvents.has('s1'), true)
  assert.equal(internals.releasedSessionEvents.has('s2'), true)
  await service.dispose()
  // 服务关闭兜底释放剩余保活句柄。
  assert.equal(internals.kept.size, 0)
  assert.deepEqual(disposed.sort(), ['s1', 's2', 's3', 's4'])
})

test('保活会话对 resumeSession 是即席可用的（不再重复 resume）', async () => {
  const { service } = await makeService()
  const liveAgent = { session: { header: { cwd: 'D:\\work\\demo' } } }
  const agents = { get: (id: unknown) => String(id) === 'kept-live' ? liveAgent : undefined }
  const serviceWithAgents = service as unknown as { readonly ctx: { agents: unknown } }
  ;(serviceWithAgents.ctx as { agents: unknown }).agents = agents
  assert.equal(await service.resumeSession('kept-live'), true)
  await service.dispose()
})
