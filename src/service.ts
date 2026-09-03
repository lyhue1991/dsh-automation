/** 持久化定义、occurrence 认领、时钟与执行调度。 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  automationDomainSpec,
  createDefinition,
  createManualRun,
  createScheduledRun,
  deleteDefinition,
  updateDefinition,
} from './domain.ts'
import { executeAutomationRun, resumeAutomationSession } from './executor.ts'
import { latestDueOccurrence, nextOccurrence, normalizeSchedule } from './recurrence.ts'
import {
  normalizePermissionPreset,
  type PermissionOption,
  type PermissionPresetService,
} from './permission-presets.ts'
import type {
  AutomationDefinition,
  AutomationRun,
  AutomationSchedule,
  PermissionPreset,
  UpdateAutomationInput,
} from './types.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const CATCH_UP_THRESHOLD_MS = 5_000
const OPTION_CACHE_TTL_MS = 30_000
const GLOBAL_HISTORY_LIMIT = 1_000
export const AUTOMATION_SESSION_PREFIX = 'dsh-automation-session-'

export interface AutomationConfig {
  readonly maxConcurrentRuns: number
  readonly runTimeoutMs: number
  readonly misfireGraceMs: number
  readonly historyLimit: number
  /** 终态后保活为交互会话的自动化 Agent 数上限；0 表示跑完立即释放。 */
  readonly liveSessionLimit: number
}

export interface WorkspaceOption {
  readonly id: string
  readonly title: string
  readonly path: string
}

export interface ModelOption {
  readonly provider: string
  readonly providerLabel: string
  readonly model: string
  readonly label: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
    }[]
    readonly defaultEffort?: string
  }
}

export interface ModelCatalogFailure {
  readonly provider: string
  readonly providerLabel: string
  readonly message: string
}

export interface AgentPresetOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly broken?: string
}

export interface CreateRequest {
  readonly name: string
  readonly prompt: string
  readonly schedule: AutomationSchedule
  readonly permissionPreset?: PermissionPreset
  readonly workspaceId?: string
  readonly cwd?: string
  readonly provider?: string | null
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly agentPreset?: string
}

export interface AutomationScope {
  readonly sessionId: string
  readonly creatorKind: 'agent' | 'web'
  readonly hostWide?: boolean
}

export interface AutomationSnapshot {
  readonly generatedAt: string
  readonly workspace: WorkspaceOption | null
  readonly workspaces: readonly WorkspaceOption[]
  readonly models: readonly ModelOption[]
  readonly modelFailures: readonly ModelCatalogFailure[]
  readonly defaultModel: ModelOption | null
  readonly skills: readonly { readonly id: string; readonly name: string }[]
  readonly presets: readonly AgentPresetOption[]
  readonly defaultPreset: string
  readonly permissions: readonly PermissionOption[]
  readonly defaultPermission: string
  readonly definitions: readonly AutomationDefinitionView[]
  readonly runs: readonly AutomationRun[]
}

export interface AutomationDefinitionView extends AutomationDefinition {
  readonly nextRunAt: string | null
  readonly lastRun: AutomationRun | null
}

/** 可安全返回给 RPC/工具调用方的输入、状态或权限错误。 */
export class AutomationRequestError extends Error {
  override readonly name = 'AutomationRequestError'
}

interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toIso(ms = Date.now()): string {
  return new Date(ms).toISOString()
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new AutomationRequestError('The automation request was cancelled.')
}

function compareRuns(left: AutomationRun, right: AutomationRun): number {
  return Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor)
    || right.id.localeCompare(left.id)
}

type AutomationAgentHandle = Awaited<ReturnType<Context['agents']['create']>>

export class AutomationService {
  private definitions!: KvTable<string, AutomationDefinition>
  private runs!: KvTable<string, AutomationRun>
  private timer: ReturnType<typeof setTimeout> | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private pumpScheduled = false
  private requested = false
  private started = false
  private stopping = false
  private optionCatalogCache: {
    readonly expiresAt: number
    readonly models: ModelOption[]
    readonly modelFailures: ModelCatalogFailure[]
    readonly defaultModel: ModelOption | null
    readonly skills: { readonly id: string; readonly name: string }[]
  } | undefined
  private readonly active = new Map<string, { readonly abort: AbortController; readonly promise: Promise<void> }>()
  private readonly resumed = new Map<string, Awaited<ReturnType<Context['agents']['resume']>>>()
  /** 跑完后保活的交互会话句柄，按完成顺序插入，供驱逐、删除与关闭统一释放。 */
  private readonly kept = new Map<string, AutomationAgentHandle>()
  private readonly releasedSessionEvents = new Set<string>()

  private constructor(
    private readonly ctx: Context,
    private readonly domain: Domain<typeof automationDomainSpec>,
    private readonly config: AutomationConfig,
    private readonly resumeOwnerCtx: Context = ctx,
    private readonly resumeOwnerDispose?: () => Promise<void>,
  ) {}

  static async open(ctx: Context, config: AutomationConfig): Promise<AutomationService> {
    const domain = await ctx.storageDomain.open(automationDomainSpec)
    // Resumed user Agents must outlive the short RPC fiber that requested them.
    // Keep their handles under a dedicated service-owned fiber instead.
    let ownerFiber: { readonly ctx: Context; readonly dispose: () => Promise<void> } | undefined
    try {
      const ownerHost = ctx as Context & {
        plugin?: (plugin: () => void) => { ctx: Context; dispose: () => Promise<void> }
      }
      ownerFiber = typeof ownerHost.plugin === 'function' ? ownerHost.plugin(() => {}) : undefined
      const service = new AutomationService(
        ctx,
        domain,
        config,
        ownerFiber?.ctx ?? ctx,
        ownerFiber === undefined ? undefined : () => ownerFiber!.dispose(),
      )
      service.definitions = domain.table('definitions') as KvTable<string, AutomationDefinition>
      service.runs = domain.table('runs') as KvTable<string, AutomationRun>
      await service.migratePermissionPresets()
      await service.recoverInterruptedRuns()
      await service.reconcileMissingSessions()
      await service.pruneAllHistory()
      return service
    } catch (error) {
      await ownerFiber?.dispose().catch(() => {})
      await domain.close().catch(() => {})
      throw error
    }
  }

  start(): void {
    if (this.started || this.stopping) return
    this.started = true
    this.requestPump()
  }

  ownsSession(sessionId: string, events: readonly SessionEventLike[] = []): boolean {
    if (sessionId.startsWith(AUTOMATION_SESSION_PREFIX)) return true
    if ([...this.runs.entries()].some(([, run]) => run.sessionId === sessionId)) return true
    return events.some((event) => {
      if (event.type !== 'user/message' || typeof event.data !== 'object' || event.data === null) return false
      const source = (event.data as { readonly source?: unknown }).source
      return typeof source === 'object' && source !== null
        && (source as { readonly kind?: unknown }).kind === 'automation'
    })
  }

  permissionNames(): readonly string[] {
    return this.permissionPresets().names
  }

  permissionOptions(): readonly PermissionOption[] {
    const presets = this.permissionPresets()
    return presets.names.map(name => presets.optionOf(name))
  }

  defaultPermission(): string {
    const presets = this.permissionPresets()
    const value = normalizePermissionPreset(presets.defaultPreset, presets.names)
    if (value === undefined) throw new Error('The Host default permission preset is not in the official preset list.')
    return value
  }

  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    const pendingOperations = this.operationTail
    const handles = [...this.active.values()]
    for (const handle of handles) handle.abort.abort()
    const resumed = [...this.resumed.values()]
    const kept = [...this.kept.values()]
    await Promise.allSettled([
      pendingOperations,
      ...handles.map(handle => handle.promise),
      ...resumed.map(handle => handle.dispose()),
      ...kept.map(handle => handle.dispose()),
    ])
    this.active.clear()
    this.resumed.clear()
    this.kept.clear()
    this.releasedSessionEvents.clear()
    await this.domain.close()
    await this.resumeOwnerDispose?.().catch(() => undefined)
  }

  async snapshot(scope: AutomationScope, signal?: AbortSignal): Promise<AutomationSnapshot> {
    return this.serialize(async () => {
      throwIfCancelled(signal)
      const now = toIso()
      const options = await this.collectOptions()
      const scoped = scope.hostWide === true ? undefined : await this.resolveScope(scope)
      const workspaceId = scoped?.workspace.id
      const definitions = [...this.definitions.entries()]
        .map(([, definition]) => definition)
        .filter(definition => workspaceId === undefined || definition.workspaceId === workspaceId)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      const runs = [...this.runs.entries()]
        .map(([, run]) => run)
        .filter(run => workspaceId === undefined || run.targetSnapshot.workspaceId === workspaceId)
        .sort(compareRuns)
      const lastByAutomation = new Map<string, AutomationRun>()
      for (const run of [...runs].reverse()) lastByAutomation.set(run.automationId, run)
      return {
        generatedAt: now,
        workspace: scoped === undefined
          ? null
          : { id: scoped.workspace.id, title: scoped.workspace.title ?? scoped.workspace.id, path: scoped.workspace.path },
        workspaces: options.workspaces,
        models: options.models,
        modelFailures: options.modelFailures,
        defaultModel: options.defaultModel,
        skills: options.skills,
        presets: options.presets,
        defaultPreset: options.defaultPreset,
        permissions: this.permissionOptions(),
        defaultPermission: this.defaultPermission(),
        definitions: definitions.map(definition => ({
          ...definition,
          nextRunAt: definition.status === 'active'
            ? nextOccurrence(definition.schedule, now)
            : null,
          lastRun: lastByAutomation.get(definition.id) ?? null,
        })),
        runs,
      }
    }, signal)
  }

  async create(scope: AutomationScope, request: CreateRequest, signal?: AbortSignal): Promise<AutomationDefinition> {
    const definition = await this.serialize(async () => {
      throwIfCancelled(signal)
      const now = toIso()
      try {
        if (request.schedule.kind === 'once'
          && nextOccurrence(request.schedule, now) === null) {
          throw new AutomationRequestError('One-shot automations must be scheduled at a future time.')
        }
      } catch (error) {
        if (error instanceof AutomationRequestError) throw error
        throw new AutomationRequestError(asMessage(error))
      }
      const target = await this.resolveCreateTarget(scope, request)
      await this.requireAgentPreset(target.agentPreset)
      let value: AutomationDefinition
      try {
        value = createDefinition({
          id: `automation_${randomUUID()}`,
          name: request.name,
          prompt: request.prompt,
          schedule: request.schedule,
          workspaceId: target.workspaceId,
          cwd: target.cwd,
          agentPreset: target.agentPreset,
          provider: target.provider,
          model: target.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          permissionPreset: this.requirePermission(request.permissionPreset),
          createdBy: { kind: scope.creatorKind, sessionId: scope.sessionId },
          now,
        })
      } catch (error) {
        throw new AutomationRequestError(asMessage(error))
      }
      await this.definitions.put(value.id, value)
      return value
    }, signal)
    this.requestPump()
    return definition
  }

  async update(
    scope: AutomationScope,
    id: string,
    input: Omit<UpdateAutomationInput, 'now'> & { readonly status?: 'active' | 'paused' },
    signal?: AbortSignal,
  ): Promise<AutomationDefinition> {
    const next = await this.serialize(async () => {
      const current = await this.ownedDefinition(scope, id)
      throwIfCancelled(signal)
      const now = toIso()
      const { status, ...fields } = input
      let normalizedFields = fields.permissionPreset === undefined
        ? fields
        : { ...fields, permissionPreset: this.requirePermission(fields.permissionPreset) }
      if (fields.workspaceId !== undefined || fields.cwd !== undefined) {
        const target = await this.resolveUpdateWorkspace(current, fields.workspaceId, fields.cwd)
        normalizedFields = { ...normalizedFields, workspaceId: target.id, cwd: target.path }
      }
      if (fields.agentPreset !== undefined) {
        normalizedFields = { ...normalizedFields, agentPreset: await this.requireAgentPreset(fields.agentPreset) }
      }
      try {
        const scheduleChanged = fields.schedule !== undefined
          && JSON.stringify(normalizeSchedule(fields.schedule)) !== JSON.stringify(current.schedule)
        if (scheduleChanged && fields.schedule?.kind === 'once'
          && nextOccurrence(fields.schedule, now) === null) {
          throw new AutomationRequestError('One-shot automations must be scheduled at a future time.')
        }
      } catch (error) {
        if (error instanceof AutomationRequestError) throw error
        throw new AutomationRequestError(asMessage(error))
      }
      const statusChanged = status !== undefined && status !== current.status
      let value: AutomationDefinition
      try {
        value = Object.keys(normalizedFields).length === 0 && !statusChanged
          ? current
          : updateDefinition(current, { ...normalizedFields, ...(status === undefined ? {} : { status }), now })
      } catch (error) {
        throw new AutomationRequestError(asMessage(error))
      }
      if (value !== current) await this.definitions.put(id, value)
      return value
    }, signal)
    this.requestPump()
    return next
  }

  async delete(
    scope: AutomationScope,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly deleted: boolean }> {
    const deleted = await this.serialize(async () => {
      const current = await this.ownedDefinition(scope, id)
      throwIfCancelled(signal)
      deleteDefinition(current)
      for (const [runId, run] of this.runs.entries()) {
        if (run.automationId !== current.id) continue
        if (run.automationName === current.name) continue
        await this.runs.update(runId, latest => (
          latest.automationId === current.id && latest.automationName !== current.name
            ? { ...latest, automationName: current.name }
            : latest
        ))
      }
      return this.definitions.delete(id)
    }, signal)
    this.requestPump()
    return { id, deleted }
  }

  async runNow(scope: AutomationScope, id: string, signal?: AbortSignal): Promise<AutomationRun> {
    const run = await this.serialize(async () => {
      const definition = await this.ownedDefinition(scope, id)
      throwIfCancelled(signal)
      const alreadyActive = [...this.runs.entries()].some(([, candidate]) => (
        candidate.automationId === id
        && (candidate.status === 'queued' || candidate.status === 'running')
      ))
      if (alreadyActive) throw new AutomationRequestError('This automation already has a queued or running task.')
      if (this.active.size >= this.config.maxConcurrentRuns) {
        throw new AutomationRequestError(
          `The maximum of ${this.config.maxConcurrentRuns} concurrent automation runs is already active. Please try again later.`,
        )
      }
      const value = createManualRun(definition, toIso())
      await this.runs.put(value.id, value)
      return value
    }, signal)
    this.requestPump()
    return run
  }

  async markRead(scope: AutomationScope, runId: string, signal?: AbortSignal): Promise<AutomationRun> {
    return this.serialize(async () => {
      const run = this.runs.get(runId)
      if (run === undefined) throw new AutomationRequestError(`unknown automation run '${runId}'`)
      throwIfCancelled(signal)
      if (scope.hostWide !== true) {
        const { workspace } = await this.resolveScope(scope)
        if (run.targetSnapshot.workspaceId !== workspace.id) {
          throw new AutomationRequestError('This run record belongs to a different workspace.')
        }
      }
      return this.runs.update(runId, current => current.unread ? { ...current, unread: false } : current)
    }, signal)
  }

  async forgetSession(sessionId: string): Promise<void> {
    const id = sessionId.trim()
    if (id === '') return
    await this.serialize(async () => {
      // Consume the completed automation's own disposal before touching a
      // newer Agent resumed for the same historical session.
      if (this.releasedSessionEvents.delete(id)) return
      const resumed = this.resumed.get(id)
      if (resumed !== undefined) {
        this.resumed.delete(id)
        await resumed.dispose().catch(() => undefined)
      }
      const kept = this.kept.get(id)
      if (kept !== undefined) {
        this.kept.delete(id)
        await kept.dispose().catch(() => undefined)
      }
      // AgentHandle.dispose removes the live session but leaves its durable log.
      // Do not mistake that lifecycle event for user deletion.
      const known = await this.knownSessionIds()
      if (known?.has(id)) return
      for (const [runId, run] of this.runs.entries()) {
        if (run.sessionId !== id) continue
        await this.runs.update(runId, latest => latest.sessionId === id ? { ...latest, sessionId: null } : latest)
      }
    })
  }

  /** 恢复一个已完成自动化的持久化 Session；重复打开复用同一个 Agent。 */
  async resumeSession(sessionId: string): Promise<boolean> {
    const id = sessionId.trim()
    if (id === '') return false
    return this.serialize(async () => {
      if (this.resumed.has(id)) return true
      if (this.ctx.agents.get(SessionId(id)) !== undefined) {
        return true
      }
      const run = [...this.runs.entries()]
        .map(([, item]) => item)
        .find(item => item.sessionId === id)
      if (run === undefined) throw new AutomationRequestError('This scheduled session has no resumable run record.')
      let handle: Awaited<ReturnType<Context['agents']['resume']>>
      try {
        handle = await resumeAutomationSession(this.ctx, run.targetSnapshot, id, this.resumeOwnerCtx)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-automation: failed to resume session '${id}': ${asMessage(error)}`)
        throw error
      }
      this.resumed.set(id, handle)
      await this.adoptSession(id).catch((error: unknown) => {
        this.ctx.logger.warn(`dsh-automation: failed to attach resumed session '${id}': ${asMessage(error)}`)
      })
      return true
    })
  }


  async reconcileMissingSessions(): Promise<void> {
    const known = await this.knownSessionIds()
    if (known === undefined) return
    await this.serialize(async () => {
      for (const [runId, run] of this.runs.entries()) {
        if (typeof run.sessionId !== "string" || run.sessionId === "") continue
        if (known.has(run.sessionId)) continue
        const missingSessionId = run.sessionId
        await this.runs.update(runId, latest => latest.sessionId === missingSessionId
          ? { ...latest, sessionId: null }
          : latest)
      }
    })
  }

  private async knownSessionIds(): Promise<Set<string> | undefined> {
    const live = this.ctx.sessions as { list?: () => readonly { readonly id: string }[] } | undefined
    let directPersistence: { list?: () => Promise<readonly { readonly id: string }[]> } | undefined
    try {
      directPersistence = (this.ctx as Context & {
        readonly sessionPersistence?: { list?: () => Promise<readonly { readonly id: string }[]> }
      }).sessionPersistence
    } catch {
      // Cordis throws when reading an uninjected service property directly.
    }
    const persistence = directPersistence
      ?? (this.ctx.get?.('sessionPersistence') as { list?: () => Promise<readonly { readonly id: string }[]> } | undefined)
    const canListLive = typeof live?.list === "function"
    const canListStored = typeof persistence?.list === "function"
    if (!canListLive && !canListStored) return undefined
    const ids = new Set<string>()
    if (canListLive && live?.list !== undefined) {
      for (const session of live.list()) ids.add(String(session.id))
    }
    if (canListStored && persistence?.list !== undefined) {
      for (const header of await persistence.list()) ids.add(String(header.id))
    }
    return ids
  }

  async forgetAutomationSessions(automationId: string): Promise<void> {
    const id = automationId.trim()
    if (id === '') return
    await this.serialize(async () => {
      for (const [runId, run] of this.runs.entries()) {
        if (run.automationId !== id || run.sessionId === null) continue
        await this.runs.update(runId, latest => latest.automationId === id && latest.sessionId !== null
          ? { ...latest, sessionId: null }
          : latest)
      }
    })
  }

  async adoptSession(sessionId: string): Promise<void> {
    const id = sessionId.trim()
    if (id === '') return
    const run = [...this.runs.entries()].map(([, item]) => item).find(item => item.sessionId === id)
    if (run === undefined) return
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(run.targetSnapshot.workspaceId))
    if (workspace === undefined) return
    await workspace.attachSession(SessionId(id))
  }

  private async resolveUpdateWorkspace(
    current: AutomationDefinition,
    workspaceId?: string,
    cwd?: string,
  ): Promise<{ readonly id: string; readonly path: string }> {
    const requestedId = workspaceId?.trim() || current.workspaceId
    const requestedPath = cwd?.trim() || current.cwd
    const registry = this.ctx.workspaceRegistry as {
      get?: (id: unknown) => any
      resolveByPath?: (path: string) => Promise<any> | any
    }
    const byId = registry.get?.(WorkspaceId(requestedId))
    const byPath = await registry.resolveByPath?.(requestedPath)
    if (byId === undefined || byPath === undefined
      || String(byId.id) !== String(byPath.id)
      || String(byId.path) !== String(byPath.path)) {
      throw new AutomationRequestError('The updated workspace must resolve to the same registered directory.')
    }
    return { id: String(byId.id), path: String(byId.path) }
  }

  private async collectOptions(): Promise<{
    readonly workspaces: WorkspaceOption[]
    readonly models: ModelOption[]
    readonly modelFailures: ModelCatalogFailure[]
    readonly defaultModel: ModelOption | null
    readonly skills: { readonly id: string; readonly name: string }[]
    readonly presets: AgentPresetOption[]
    readonly defaultPreset: string
  }> {
    const registry = this.ctx.workspaceRegistry as {
      list?: () => Iterable<any>
      values?: () => Iterable<any>
      entries?: () => Iterable<[string, any]>
    }
    const raw = registry.list !== undefined
      ? [...registry.list()]
      : registry.values !== undefined
        ? [...registry.values()]
        : registry.entries !== undefined
          ? [...registry.entries()].map(([, value]) => value)
          : []
    const workspaces = raw
      .map((item) => ({
        id: String(item.id ?? item.workspaceId ?? ''),
        title: String(item.title ?? item.name ?? item.id ?? item.path ?? ''),
        path: String(item.path ?? item.cwd ?? ''),
      }))
      .filter(item => item.id !== '' && item.path !== '')
    const agentPresets = this.ctx.agentPresets as {
      list?: () => Promise<readonly { id: string; name?: string; description?: string; broken?: string }[]>
      defaultId?: string
    }
    const presets = (await agentPresets.list?.() ?? []).map(item => ({
      id: String(item.id),
      name: String(item.name ?? item.id),
      ...(item.description === undefined ? {} : { description: String(item.description) }),
      ...(item.broken === undefined ? {} : { broken: String(item.broken) }),
    }))
    const defaultPreset = String(agentPresets.defaultId ?? 'standard')
    const now = Date.now()
    let catalog = this.optionCatalogCache
    if (catalog === undefined || catalog.expiresAt <= now) {
      const collected = await collectModelOptions(this.ctx)
      catalog = {
        expiresAt: now + OPTION_CACHE_TTL_MS,
        models: collected.models,
        modelFailures: collected.failures,
        defaultModel: collected.defaultModel,
        skills: collectSkillOptions(),
      }
      this.optionCatalogCache = catalog
    }
    return {
      workspaces,
      models: catalog.models,
      modelFailures: catalog.modelFailures,
      defaultModel: catalog.defaultModel,
      skills: catalog.skills,
      presets,
      defaultPreset,
    }
  }

  private async resolveCreateTarget(scope: AutomationScope, request: CreateRequest) {
    const fallback = this.ctx.agentDefaultModel?.currentSelection?.()
    let workspaceId = request.workspaceId?.trim() ?? ''
    let cwd = request.cwd?.trim() ?? ''
    const configuredDefault = String((this.ctx.agentPresets as { defaultId?: string }).defaultId ?? 'standard')
    let agentPreset = request.agentPreset?.trim() || configuredDefault
    let provider = request.provider ?? fallback?.provider ?? null
    let model = request.model ?? fallback?.model ?? null
    if (workspaceId !== '' || cwd !== '') {
      const registry = this.ctx.workspaceRegistry as {
        get?: (id: unknown) => any
        resolveByPath?: (path: string) => Promise<any> | any
      }
      const byId = workspaceId === '' ? undefined : registry.get?.(WorkspaceId(workspaceId))
      const byPath = cwd === '' ? undefined : await registry.resolveByPath?.(cwd)
      if (workspaceId !== '' && cwd !== '' && (
        byId === undefined || byPath === undefined
        || String(byId.id) !== String(byPath.id)
        || String(byId.path) !== String(byPath.path)
      )) {
        throw new AutomationRequestError('The workspace ID and directory must resolve to the same registered directory.')
      }
      const workspace = byId ?? byPath
      if (workspace === undefined) throw new AutomationRequestError('The selected workspace does not exist or its directory is not registered.')
      workspaceId = String(workspace.id)
      cwd = String(workspace.path)
    } else {
      const resolved = await this.resolveScope(scope)
      workspaceId = resolved.workspace.id
      cwd = resolved.workspace.path
      agentPreset = request.agentPreset?.trim()
        || this.ctx.agentPresets.composedPreset(resolved.agent.ctx)
        || resolved.agent.session.header.agentPreset
        || agentPreset
      const loggedSelection = resolved.agent.session.requestHeader()?.config
      provider = request.provider ?? loggedSelection?.provider ?? provider
      model = request.model ?? loggedSelection?.model ?? model
    }
    return { workspaceId, cwd, agentPreset, provider, model }
  }

  private async resolveScope(scope: AutomationScope) {
    const agent = this.ctx.agents.get(SessionId(scope.sessionId))
    if (agent === undefined) throw new AutomationRequestError('The automation UI or tools require a live source Session.')
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new AutomationRequestError('The source Session has no workspace directory.')
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new AutomationRequestError('The source Session directory is not registered as a DSH workspace.')
    if (this.ctx.agents.get(SessionId(scope.sessionId)) !== agent) {
      throw new AutomationRequestError('The automation UI or tools require a live source Session.')
    }
    return { agent, workspace }
  }

  private async ownedDefinition(scope: AutomationScope, id: string): Promise<AutomationDefinition> {
    const definition = this.definitions.get(id)
    if (definition === undefined) throw new AutomationRequestError(`unknown automation '${id}'`)
    if (scope.hostWide === true) return definition
    const { workspace } = await this.resolveScope(scope)
    if (definition.workspaceId !== workspace.id) throw new AutomationRequestError('This automation belongs to a different workspace.')
    return definition
  }

  private requestPump(): void {
    if (this.stopping || !this.started) return
    this.clearTimer()
    this.requested = true
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    void this.serialize(async () => {
      try {
        while (this.requested && !this.stopping) {
          this.requested = false
          await this.pumpOnce()
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`dsh-automation: scheduler pump failed: ${asMessage(error)}`)
        this.armRetryTimer()
      } finally {
        this.pumpScheduled = false
      }
    }).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`dsh-automation: scheduler admission failed: ${asMessage(error)}`)
    })
  }

  private async pumpOnce(): Promise<void> {
    if (this.stopping) return
    const now = toIso()
    const runsByAutomation = new Map<string, AutomationRun[]>()
    for (const [, run] of this.runs.entries()) {
      const related = runsByAutomation.get(run.automationId) ?? []
      related.push(run)
      runsByAutomation.set(run.automationId, related)
    }
    for (const [, definition] of this.definitions.entries()) {
      if (definition.status !== 'active') continue
      await this.claimLatestDue(definition, now, runsByAutomation.get(definition.id) ?? [])
    }
    if (this.stopping) return
    await this.startQueuedRuns()
    if (this.stopping) return
    this.armNextTimer(now)
  }

  private async claimLatestDue(
    definition: AutomationDefinition,
    now: string,
    related: readonly AutomationRun[],
  ): Promise<void> {
    const scheduledFor = latestDueOccurrence(definition.schedule, now)
    if (scheduledFor === null || Date.parse(scheduledFor) <= Date.parse(definition.updatedAt)) return
    const overlapping = related.some(run => run.status === 'queued' || run.status === 'running')
    const age = Date.parse(now) - Date.parse(scheduledFor)
    if (related.some(run => (run.trigger === 'schedule' || run.trigger === 'catch-up') && run.scheduledFor === scheduledFor)) return
    const candidate = createScheduledRun(definition, scheduledFor, age > CATCH_UP_THRESHOLD_MS ? 'catch-up' : 'schedule')
    if (this.runs.get(candidate.id) !== undefined) return
    if (overlapping || age > this.config.misfireGraceMs) {
      const reason = overlapping
        ? { code: 'overlap', message: 'Skipped because the previous run is still in progress.' }
        : { code: 'misfire', message: 'Skipped because the Host recovered after the misfire grace window.' }
      await this.runs.put(candidate.id, {
        ...candidate,
        status: 'skipped',
        finishedAt: now,
        error: reason,
      })
      await this.pruneWorkspaceHistory(candidate.targetSnapshot.workspaceId)
      return
    }
    await this.runs.put(candidate.id, candidate)
  }

  private async startQueuedRuns(): Promise<void> {
    if (this.stopping) return
    const capacity = Math.max(0, this.config.maxConcurrentRuns - this.active.size)
    if (capacity === 0) return
    const activeAutomationIds = new Set(
      [...this.active.keys()]
        .map(id => this.runs.get(id)?.automationId)
        .filter((id): id is string => id !== undefined),
    )
    const candidates = [...this.runs.entries()].map(([, run]) => run)
      .filter(run => run.status === 'queued' && !this.active.has(run.id))
      .sort((left, right) => Date.parse(left.scheduledFor) - Date.parse(right.scheduledFor))
    const queued: AutomationRun[] = []
    for (const run of candidates) {
      if (activeAutomationIds.has(run.automationId)) continue
      activeAutomationIds.add(run.automationId)
      queued.push(run)
      if (queued.length === capacity) break
    }
    for (const run of queued) this.startRun(run)
  }

  private startRun(run: AutomationRun): void {
    const abort = new AbortController()
    const promise = this.executeRun(run, abort.signal)
      .catch(async (error: unknown) => {
        this.ctx.logger.warn(`dsh-automation: run '${run.id}' failed outside its execution boundary: ${asMessage(error)}`)
        try {
          const current = this.runs.get(run.id)
          if (current === undefined || (current.status !== 'queued' && current.status !== 'running')) return
          await this.runs.put(run.id, {
            ...current,
            status: 'failed',
            finishedAt: toIso(),
            error: { code: 'executor_error', message: asMessage(error) },
            unread: true,
          })
        } catch (persistError: unknown) {
          this.ctx.logger.warn(`dsh-automation: failed to persist run failure: ${asMessage(persistError)}`)
        }
      })
      .finally(() => {
        this.active.delete(run.id)
        this.requestPump()
      })
    this.active.set(run.id, { abort, promise })
  }

  private async executeRun(run: AutomationRun, signal: AbortSignal): Promise<void> {
    const definition = this.definitions.get(run.automationId)
    if (definition === undefined) {
      await this.runs.put(run.id, {
        ...run,
        status: 'failed',
        finishedAt: toIso(),
        error: { code: 'definition_deleted', message: 'The automation definition was deleted before this run started.' },
      })
      await this.pruneWorkspaceHistory(run.targetSnapshot.workspaceId)
      return
    }
    const startedAt = toIso()
    const sessionId = `${AUTOMATION_SESSION_PREFIX}${randomUUID()}`
    const running: AutomationRun = { ...run, status: 'running', startedAt, sessionId }
    await this.runs.put(run.id, running)
    const completion = await executeAutomationRun(this.ctx, definition, run, {
      runTimeoutMs: this.config.runTimeoutMs,
      sessionId,
      signal,
      onHandleDisposed: (id) => { this.releasedSessionEvents.add(id) },
      keepSessionOnCompletion: this.config.liveSessionLimit > 0,
      onHandleKept: (id, handle) => {
        this.kept.set(id, handle)
        this.evictKeptSessions()
      },
    })
    const finishedAt = toIso()
    const boundSessionId = completion.sessionId ?? running.sessionId
    await this.runs.update(run.id, current => ({
      ...current,
      status: completion.status,
      sessionId: completion.sessionId ?? null,
      finishedAt,
      summary: completion.summary ?? null,
      error: completion.error ?? null,
      unread: true,
    }))
    if (typeof boundSessionId === 'string' && boundSessionId !== '') {
      await this.adoptSession(boundSessionId).catch(() => undefined)
    }
    await this.pruneWorkspaceHistory(run.targetSnapshot.workspaceId)
  }

  /** 超出保留上限时回收最旧的已完结自动化 Agent；正在执行用户回合的会话跳过。 */
  private evictKeptSessions(): void {
    const limit = Math.max(0, this.config.liveSessionLimit)
    for (const [id, handle] of this.kept) {
      if (this.kept.size <= limit) return
      if (handle.agent.status === 'running') continue
      this.kept.delete(id)
      this.releaseKeptSession(id, handle)
    }
  }

  /** 回收仍然存活的会话：登记释放标记，避免 dispose 事件被当成用户删除。 */
  private releaseKeptSession(id: string, handle: AutomationAgentHandle): void {
    this.releasedSessionEvents.add(id)
    void handle.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-automation: failed to release kept session '${id}': ${asMessage(error)}`)
    })
  }

  private armNextTimer(now: string): void {
    if (this.stopping) return
    let target: number | undefined
    for (const [, definition] of this.definitions.entries()) {
      if (definition.status !== 'active') continue
      const next = nextOccurrence(definition.schedule, now)
      if (next === null) continue
      const candidate = Date.parse(next)
      if (target === undefined || candidate < target) target = candidate
    }
    if (target === undefined) return
    const delay = Math.max(1, Math.min(target - Date.parse(now), MAX_TIMER_DELAY_MS))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestPump()
    }, delay)
  }

  private armRetryTimer(): void {
    if (this.stopping || this.timer !== undefined) return
    const delay = Math.max(1_000, Math.min(60_000, this.config.misfireGraceMs || 60_000))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestPump()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private serialize<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('The automation service is shutting down.'))
    if (signal?.aborted === true) return Promise.reject(new Error('The automation request was cancelled.'))
    const result = this.operationTail.then(async () => {
      throwIfCancelled(signal)
      return operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private permissionPresets(): PermissionPresetService {
    return (this.ctx as Context & { permissionPresets: PermissionPresetService }).permissionPresets
  }

  private requirePermission(input?: PermissionPreset): PermissionPreset {
    const presets = this.permissionPresets()
    if (input === undefined) return this.defaultPermission()
    const value = normalizePermissionPreset(input, presets.names)
    if (value === undefined) throw new AutomationRequestError(`unknown permission preset '${input}'`)
    return value
  }

  private async requireAgentPreset(input: string): Promise<string> {
    const id = input.trim()
    if (id === '') throw new AutomationRequestError('agent preset 不能为空')
    const roster = this.ctx.agentPresets as {
      resolve?: (presetId: string) => Promise<unknown>
      list?: () => Promise<readonly { id: string }[]>
    }
    if (roster.resolve !== undefined) {
      try { await roster.resolve(id) } catch (error) { throw new AutomationRequestError(`unknown agent preset '${id}': ${asMessage(error)}`) }
    } else if (roster.list !== undefined) {
      const found = (await roster.list()).some(item => item.id === id)
      if (!found) throw new AutomationRequestError(`unknown agent preset '${id}'`)
    }
    return id
  }

  /** 把旧版 full-access 及已移除的预设收敛到 Host 当前可用列表。 */
  private async migratePermissionPresets(): Promise<void> {
    const presets = this.permissionPresets()
    const fallback = this.defaultPermission()
    for (const [id, definition] of this.definitions.entries()) {
      const permissionPreset = normalizePermissionPreset(definition.permissionPreset, presets.names) ?? fallback
      if (permissionPreset === definition.permissionPreset) continue
      await this.definitions.put(id, { ...definition, permissionPreset })
    }
    for (const [id, run] of this.runs.entries()) {
      const permissionPreset = normalizePermissionPreset(run.targetSnapshot.permissionPreset, presets.names) ?? fallback
      if (permissionPreset === run.targetSnapshot.permissionPreset) continue
      await this.runs.put(id, {
        ...run,
        targetSnapshot: { ...run.targetSnapshot, permissionPreset },
      })
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const finishedAt = toIso()
    for (const [id, run] of this.runs.entries()) {
      if (run.status !== 'queued' && run.status !== 'running') continue
      await this.runs.put(id, {
        ...run,
        status: 'failed',
        finishedAt,
        error: {
          code: 'host_interrupted',
          message: 'The DSH Host stopped before this run reached a terminal state.',
        },
        unread: true,
      })
    }
  }

  private async pruneWorkspaceHistory(workspaceId: string): Promise<void> {
    const terminalByAutomation = new Map<string, AutomationRun[]>()
    for (const run of [...this.runs.entries()]
      .map(([, run]) => run)
      .filter(run => run.targetSnapshot.workspaceId === workspaceId
        && run.status !== 'queued' && run.status !== 'running')
    ) {
      const existing = terminalByAutomation.get(run.automationId) ?? []
      existing.push(run)
      terminalByAutomation.set(run.automationId, existing)
    }
    for (const terminal of terminalByAutomation.values()) {
      terminal.sort(compareRuns)
      for (const run of terminal.slice(this.config.historyLimit)) await this.runs.delete(run.id)
    }
    await this.pruneGlobalHistory()
  }

  /** 全局只清理终态记录，绝不删除仍在排队或执行中的运行。 */
  private async pruneGlobalHistory(): Promise<void> {
    const terminal = [...this.runs.entries()]
      .map(([, run]) => run)
      .filter(run => run.status !== 'queued' && run.status !== 'running')
      .sort(compareRuns)
    for (const run of terminal.slice(GLOBAL_HISTORY_LIMIT)) await this.runs.delete(run.id)
  }

  private async pruneAllHistory(): Promise<void> {
    const workspaces = new Set(
      [...this.runs.entries()].map(([, run]) => run.targetSnapshot.workspaceId),
    )
    for (const workspaceId of workspaces) await this.pruneWorkspaceHistory(workspaceId)
  }
}




async function collectModelOptions(ctx: Context): Promise<{
  readonly models: ModelOption[]
  readonly failures: ModelCatalogFailure[]
  readonly defaultModel: ModelOption | null
}> {
  const found: ModelOption[] = []
  const failures: ModelCatalogFailure[] = []
  const seen = new Set<string>()
  const push = (item: ModelOption): void => {
    const { provider, model } = item
    if (provider === '' || model === '') return
    const key = `${provider}::${model}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(item)
  }

  const current = ctx.agentDefaultModel?.currentSelection?.() ?? null
  const llm = (ctx as Context & { llm?: {
    listProviders?: () => readonly { id?: string; provider?: string; name?: string }[]
    listModels?: (provider: string) => Promise<readonly { id?: string; name?: string; description?: string }[]>
    resolveModelInfo?: (provider: string, model: string) => Promise<{
      description?: string
      reasoning?: {
        efforts: readonly { id: string; name: string; description?: string }[]
        defaultEffort?: string
      }
    }>
  } }).llm
  for (const item of llm?.listProviders?.() ?? []) {
    const provider = String(item.id ?? item.provider ?? '')
    if (provider === '') continue
    const providerLabel = String(item.name ?? provider)
    try {
      const models = await llm?.listModels?.(provider) ?? []
      const entries = await Promise.all(models.map(async (model: { id?: string; name?: string; description?: string }): Promise<ModelOption | null> => {
        const modelId = String(model.id ?? '')
        if (modelId === '') return null
        const resolved = llm?.resolveModelInfo === undefined
          ? undefined
          : await llm.resolveModelInfo(provider, modelId)
        const reasoning = resolved?.reasoning === undefined
          ? undefined
          : {
              efforts: resolved.reasoning.efforts.map((effort: { id: string; name: string; description?: string }) => ({
                id: String(effort.id),
                name: String(effort.name),
                ...(effort.description === undefined ? {} : { description: String(effort.description) }),
              })),
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: String(resolved.reasoning.defaultEffort) }),
            }
        return {
          provider,
          providerLabel,
          model: modelId,
          label: model.name?.trim() || prettyModelLabel({}, provider, modelId),
          ...(resolved?.description ?? model.description) === undefined
            ? {}
            : { description: String(resolved?.description ?? model.description) },
          ...(reasoning === undefined ? {} : { reasoning }),
        }
      }))
      for (const entry of entries) {
        if (entry !== null) push(entry)
      }
    } catch (error) {
      failures.push({
        provider,
        providerLabel,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const defaultModel = current === null
    ? found[0] ?? null
    : found.find(item => item.provider === current.provider && item.model === current.model) ?? found[0] ?? null
  return { models: found, failures, defaultModel }
}

function prettyModelLabel(_item: any, _provider: string, model: string): string {
  return model.split(/[-_]/g).map((part) => {
    if (part.toLowerCase() === 'deepseek') return 'DeepSeek'
    if (/^v\d/i.test(part)) return part.slice(0, 1).toUpperCase() + part.slice(1)
    if (part === '') return part
    return part.slice(0, 1).toUpperCase() + part.slice(1)
  }).join('-') || model
}

function collectSkillOptions(): { readonly id: string; readonly name: string }[] {
  const seen = new Set<string>()
  const skills: { readonly id: string; readonly name: string }[] = []
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || homedir()
  const roots = [
    join(process.env.DSH_HOME?.trim() || join(home, '.dsh'), 'skills'),
    join(home, '.dsh', 'skills'),
    join(process.env.DSH_AGENTS_HOME?.trim() || join(home, '.agents'), 'skills'),
    join(home, '.agents', 'skills'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries: import('node:fs').Dirent[] = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const id = entry.name
        if (seen.has(id)) continue
        seen.add(id)
        skills.push({ id, name: readSkillTitle(join(root, id, 'SKILL.md')) ?? id })
      } else if (entry.name.endsWith('.md')) {
        const id = entry.name.replace(/\.md$/i, '')
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        skills.push({ id, name: readSkillTitle(join(root, entry.name)) ?? id })
      }
    }
  }
  return skills
}

function readSkillTitle(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8')
    const match = text.match(/^name:\s*(.+)$/m)
    const value = match?.[1]?.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}
