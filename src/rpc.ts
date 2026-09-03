/** 仅 loopback 的 Web 客户端 RPC 适配器。 */

import { AutomationRequestError, type AutomationService } from './service.ts'
import type { AutomationSchedule as DomainSchedule, Weekday } from './types.ts'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

class RpcRequestError extends Error {
  override readonly name = 'RpcRequestError'
}

interface RpcContext {
  readonly logger: {
    warn(message: string): void
  }
  readonly connection: {
    readonly rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
        options: { readonly authority: 'loopback' | 'trusted-host' },
      ): () => Promise<void>
    }
  }
}

function isBadRequest(error: unknown): boolean {
  return error instanceof RpcRequestError || error instanceof AutomationRequestError
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcRequestError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RpcRequestError(`${label} must be a non-empty string`)
  if (maxLength !== undefined && value.length > maxLength) throw new RpcRequestError(`${label} must be at most ${maxLength} characters`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new RpcRequestError(`${label} must be an integer`)
  return value
}

function toDomainSchedule(raw: unknown, timeZone: string): DomainSchedule {
  const schedule = record(raw, 'schedule')
  const kind = string(schedule.kind, 'schedule.kind')
  switch (kind) {
    case 'once':
      return { kind, at: string(schedule.at, 'schedule.at'), timeZone }
    case 'interval': {
      const everyMinutes = integer(schedule.everyMinutes, 'schedule.everyMinutes')
      return {
        kind,
        everyMinutes,
        anchor: optionalString(schedule.anchor, 'schedule.anchor') ?? new Date().toISOString(),
        timeZone,
      }
    }
    case 'daily':
      return { kind, time: string(schedule.time, 'schedule.time'), timeZone }
    case 'weekly': {
      if (!Array.isArray(schedule.weekdays)) throw new RpcRequestError('schedule.weekdays must be an array')
      const weekdays = schedule.weekdays.map((value) => {
        const number = integer(value, 'schedule.weekdays[]')
        const weekday = WEEKDAYS[number - 1]
        if (weekday === undefined) throw new RpcRequestError('schedule.weekdays must contain numbers from 1 to 7')
        return weekday
      })
      return { kind, time: string(schedule.time, 'schedule.time'), weekdays, timeZone }
    }
    case 'hourly':
      return { kind, minute: integer(schedule.minute, 'schedule.minute'), timeZone }
    case 'monthly':
      return { kind, day: integer(schedule.day, 'schedule.day'), time: string(schedule.time, 'schedule.time'), timeZone }
    case 'custom':
      return { kind, everyDays: integer(schedule.everyDays, 'schedule.everyDays'), time: string(schedule.time, 'schedule.time'), timeZone }
    default:
      throw new RpcRequestError('schedule.kind must be once, interval, daily, weekly, hourly, monthly, or custom')
  }
}

function toClientSchedule(schedule: DomainSchedule): Record<string, unknown> {
  if (schedule.kind !== 'weekly') return { ...schedule }
  return {
    ...schedule,
    weekdays: schedule.weekdays.map(day => WEEKDAYS.indexOf(day) + 1),
  }
}

function errorResult(
  error: unknown,
  aborted = false,
): { readonly ok: false; readonly error: Record<string, unknown> } {
  if (aborted) {
    return {
      ok: false,
      error: { code: 'cancelled', message: 'The automation request was cancelled.', details: {} },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const badRequest = isBadRequest(error)
  return {
    ok: false,
    error: {
      code: badRequest ? 'bad-request' : 'internal',
      message: badRequest ? message : 'The automation service could not complete the request.',
      details: badRequest ? { issues: [] } : {},
    },
  }
}

function scopeOf(payload: Record<string, unknown>) {
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim() !== ''
    ? payload.sessionId.trim()
    : 'settings'
  return { sessionId, creatorKind: 'web' as const, hostWide: true }
}

async function snapshotValue(service: AutomationService, payload: Record<string, unknown>, signal: AbortSignal) {
  const snapshot = await service.snapshot(scopeOf(payload), signal)
  const names = new Map(snapshot.definitions.map(definition => [definition.id, definition.name]))
  return {
    scope: {
      workspaceId: snapshot.workspace?.id,
      workspaceName: snapshot.workspace?.title,
      cwd: snapshot.workspace?.path ?? '',
    },
    workspaces: snapshot.workspaces,
    models: snapshot.models,
    modelFailures: snapshot.modelFailures,
    defaultModel: snapshot.defaultModel,
    skills: snapshot.skills,
    presets: snapshot.presets,
    defaultPreset: snapshot.defaultPreset,
    permissions: snapshot.permissions,
    defaultPermission: snapshot.defaultPermission,
    automations: snapshot.definitions.map(definition => ({
      id: definition.id,
      revision: definition.revision,
      name: definition.name,
      prompt: definition.prompt,
      status: definition.status,
      schedule: toClientSchedule(definition.schedule),
      scheduleSummary: definition.rrule,
      timeZone: definition.timeZone,
      permission: definition.permissionPreset,
      agentPreset: definition.agentPreset,
      ...(definition.nextRunAt === null ? {} : { nextRunAt: definition.nextRunAt }),
      ...(definition.lastRun === null ? {} : {
        lastRunAt: definition.lastRun.finishedAt ?? definition.lastRun.startedAt ?? definition.lastRun.scheduledFor,
        lastRunStatus: definition.lastRun.error?.code === 'host_interrupted'
          ? 'interrupted'
          : definition.lastRun.status,
      }),
      workspaceId: definition.workspaceId,
      cwd: definition.cwd,
      provider: definition.provider,
      model: definition.model,
      reasoningEffort: definition.reasoningEffort,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    })),
    runs: snapshot.runs.map(run => ({
      id: run.id,
      automationId: run.automationId,
      automationName: names.get(run.automationId) ?? run.automationName ?? run.automationId,
      status: run.error?.code === 'host_interrupted' ? 'interrupted' : run.status,
      trigger: run.trigger,
      scheduledFor: run.scheduledFor,
      ...(run.startedAt === null ? {} : { startedAt: run.startedAt }),
      ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt }),
      ...(run.sessionId === null ? {} : { sessionId: run.sessionId }),
      ...(run.summary === null ? {} : { summary: run.summary }),
      ...(run.error === null ? {} : { error: run.error.message }),
      unread: run.unread,
    })),
    serverNow: snapshot.generatedAt,
  }
}

export function registerAutomationRpc(ctx: RpcContext, service: AutomationService): () => Promise<void> {
  return ctx.connection.rpc.handle('/dsh-automation', async (endpoint, rawPayload, signal) => {
    try {
      const payload = record(rawPayload, 'payload')
      switch (endpoint) {
        case 'snapshot':
          return { ok: true, value: await snapshotValue(service, payload, signal) }
        case 'reference-files': {
          const snapshot = await service.snapshot(scopeOf(payload), signal)
          const cwd = snapshot.workspaces.find(item => item.id === payload.workspaceId)?.path ?? snapshot.workspace?.path
          if (typeof cwd !== 'string' || cwd === '') return { ok: true, value: [] }
          const query = typeof payload.query === 'string' ? payload.query.toLowerCase() : ''
          const results: Array<{ path: string; directory: boolean }> = []
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > 3 || results.length >= 80 || signal.aborted) return
            let entries
            try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
            for (const entry of entries) {
              if (entry.name.startsWith('.') || results.length >= 80) continue
              const path = relative(cwd, join(dir, entry.name))
              if (query !== '' && !path.toLowerCase().includes(query)) {
                if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1)
                continue
              }
              results.push({ path, directory: entry.isDirectory() })
              if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1)
            }
          }
          await walk(cwd, 0)
          return { ok: true, value: results.slice(0, 50) }
        }
        case 'create': {
          const input = record(payload.input, 'input')
          const timeZone = string(input.timeZone, 'input.timeZone')
          const created = await service.create(scopeOf(payload), {
            name: string(input.name, 'input.name', 200),
            prompt: string(input.prompt, 'input.prompt', 100_000),
            schedule: toDomainSchedule(input.schedule, timeZone),
            permissionPreset: string(input.permission, 'input.permission'),
            ...(input.workspaceId === undefined ? {} : { workspaceId: string(input.workspaceId, 'input.workspaceId') }),
            ...(input.cwd === undefined ? {} : { cwd: string(input.cwd, 'input.cwd') }),
            ...(input.provider === undefined ? {} : { provider: input.provider === null ? null : string(input.provider, 'input.provider') }),
            ...(input.model === undefined ? {} : { model: input.model === null ? null : string(input.model, 'input.model') }),
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort === null ? null : string(input.reasoningEffort, 'input.reasoningEffort') }),
            ...(input.agentPreset === undefined ? {} : { agentPreset: string(input.agentPreset, 'input.agentPreset') }),
          }, signal)
          return { ok: true, value: { id: created.id } }
        }
        case 'mutate': {
          const id = string(payload.automationId, 'automationId')
          const mutation = string(payload.mutation, 'mutation')
          if (mutation === 'delete') {
            return { ok: true, value: await service.delete(scopeOf(payload), id, signal) }
          }
          if (mutation !== 'pause' && mutation !== 'resume') {
            throw new RpcRequestError('mutation must be pause, resume, or delete')
          }
          const value = await service.update(scopeOf(payload), id, {
            status: mutation === 'pause' ? 'paused' : 'active',
          }, signal)
          return { ok: true, value: { id: value.id, revision: value.revision } }
        }
        case 'update': {
          const id = string(payload.automationId, 'automationId')
          const input = record(payload.input, 'input')
          const timeZone = string(input.timeZone, 'input.timeZone')
          const value = await service.update(scopeOf(payload), id, {
            name: string(input.name, 'input.name', 200),
            prompt: string(input.prompt, 'input.prompt', 100_000),
            schedule: toDomainSchedule(input.schedule, timeZone),
            permissionPreset: string(input.permission, 'input.permission'),
            ...(input.workspaceId === undefined ? {} : { workspaceId: string(input.workspaceId, 'input.workspaceId') }),
            ...(input.cwd === undefined ? {} : { cwd: string(input.cwd, 'input.cwd') }),
            ...(input.provider === undefined ? {} : { provider: input.provider === null ? null : string(input.provider, 'input.provider') }),
            ...(input.model === undefined ? {} : { model: input.model === null ? null : string(input.model, 'input.model') }),
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort === null ? null : string(input.reasoningEffort, 'input.reasoningEffort') }),
            ...(input.agentPreset === undefined ? {} : { agentPreset: string(input.agentPreset, 'input.agentPreset') }),
          }, signal)
          return { ok: true, value: { id: value.id, revision: value.revision } }
        }
        case 'run-now': {
          const run = await service.runNow(scopeOf(payload), string(payload.automationId, 'automationId'), signal)
          return { ok: true, value: { runId: run.id } }
        }
        case 'mark-read': {
          const run = await service.markRead(scopeOf(payload), string(payload.runId, 'runId'), signal)
          return { ok: true, value: { runId: run.id, unread: run.unread } }
        }
        case 'adopt-session': {
          await service.adoptSession(string(payload.sessionId, 'sessionId'))
          return { ok: true, value: { sessionId: string(payload.sessionId, 'sessionId') } }
        }
        case 'resume-session': {
          const sessionId = string(payload.sessionId, 'sessionId')
          return { ok: true, value: { sessionId, resumed: await service.resumeSession(sessionId) } }
        }
        case 'forget-session': {
          await service.forgetSession(string(payload.sessionId, 'sessionId'))
          return { ok: true, value: { sessionId: string(payload.sessionId, 'sessionId') } }
        }
        case 'forget-automation-sessions': {
          await service.forgetAutomationSessions(string(payload.automationId, 'automationId'))
          return { ok: true, value: { automationId: string(payload.automationId, 'automationId') } }
        }
        default:
          throw new RpcRequestError(`unknown automation endpoint '${endpoint}'`)
      }
    } catch (error) {
      if (!signal.aborted && !isBadRequest(error)) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error)
        ctx.logger.warn(`dsh-automation: RPC '${endpoint}' failed: ${detail}`)
      }
      return errorResult(error, signal.aborted)
    }
  }, { authority: 'loopback' })
}
