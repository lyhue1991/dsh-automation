/** 绑定到单个 root Agent 工作区的管理工具。 */

import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AutomationService } from './service.ts'
import { AUTOMATION_CREATE_DESCRIPTION } from './prompt.ts'
import type { AutomationSchedule, PermissionPreset, Weekday } from './types.ts'

interface ToolAgent {
  readonly id: string
  readonly ctx: {
    readonly tools: { register(definition: unknown): () => void }
  }
}

const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

interface ScheduleArgs {
  readonly kind?: 'once' | 'interval' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
  readonly time_zone?: string
  readonly at?: string
  readonly every_minutes?: number
  readonly minute?: number
  readonly time?: string
  readonly weekdays?: string[]
  readonly month_day?: number
  readonly every_days?: number
}

interface CreateArgs extends ScheduleArgs {
  readonly name: string
  readonly prompt: string
  readonly kind: 'once' | 'interval' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
  readonly time_zone: string
  readonly permission?: PermissionPreset
  readonly preset?: string
}

interface ManageArgs extends ScheduleArgs {
  readonly id: string
  readonly action: 'update' | 'pause' | 'resume' | 'run_now' | 'delete'
  readonly name?: string
  readonly prompt?: string
  readonly status?: 'active' | 'paused'
  readonly permission?: PermissionPreset
  readonly preset?: string
}

interface GetArgs { readonly id?: string; readonly include_runs?: boolean; readonly status?: string }

const SCHEDULE_FIELDS = [
  'time_zone', 'at', 'every_minutes', 'minute', 'time', 'weekdays', 'month_day', 'every_days',
] as const

function render(_args: unknown, value: JsonValue): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render,
} as const

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown) {
  return { card: 'generic' as const, title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

function validateScheduleSelector(args: ScheduleArgs): void {
  const presentFields = SCHEDULE_FIELDS.filter(field => args[field] !== undefined)
  if (args.kind === undefined) {
    if (presentFields.length > 0) throw new Error('kind is required when changing schedule fields')
    return
  }
  const required = args.kind === 'once'
    ? ['time_zone', 'at'] as const
    : args.kind === 'interval'
      ? ['time_zone', 'every_minutes'] as const
      : args.kind === 'hourly'
        ? ['time_zone', 'minute'] as const
        : args.kind === 'weekly'
          ? ['time_zone', 'time', 'weekdays'] as const
          : args.kind === 'monthly'
            ? ['time_zone', 'time', 'month_day'] as const
            : args.kind === 'custom'
              ? ['time_zone', 'time', 'every_days'] as const
              : ['time_zone', 'time'] as const
  const allowed = new Set<string>(required)
  const missing = required.filter(field => args[field] === undefined)
  if (missing.length > 0) throw new Error(`${args.kind} schedule requires: ${missing.join(', ')}`)
  const unrelated = presentFields.filter(field => !allowed.has(field))
  if (unrelated.length > 0) throw new Error(`${args.kind} schedule does not accept: ${unrelated.join(', ')}`)
}

function scheduleFromArgs(args: ScheduleArgs, now: string): AutomationSchedule {
  validateScheduleSelector(args)
  const timeZone = String(args.time_zone ?? '')
  switch (args.kind) {
    case 'once':
      return { kind: 'once', at: String(args.at ?? ''), timeZone }
    case 'interval':
      return { kind: 'interval', everyMinutes: Number(args.every_minutes), anchor: now, timeZone }
    case 'hourly':
      return { kind: 'hourly', minute: Number(args.minute), timeZone }
    case 'daily':
      return { kind: 'daily', time: String(args.time ?? ''), timeZone }
    case 'weekly': {
      const weekdays = Array.isArray(args.weekdays) ? args.weekdays.map(String) : []
      if (weekdays.some(day => !WEEKDAYS.includes(day as Weekday))) throw new Error('weekdays contains invalid values')
      return { kind: 'weekly', weekdays: weekdays as Weekday[], time: String(args.time ?? ''), timeZone }
    }
    case 'monthly':
      return { kind: 'monthly', day: Number(args.month_day), time: String(args.time ?? ''), timeZone }
    case 'custom':
      return { kind: 'custom', everyDays: Number(args.every_days), time: String(args.time ?? ''), timeZone }
    default:
      throw new Error('kind must be one of: once, interval, hourly, daily, weekly, monthly, custom')
  }
}

export function registerAutomationTools(service: AutomationService, agent: ToolAgent): () => void {
  const scope = { sessionId: agent.id, creatorKind: 'agent' as const }
  const permissionNames = [...service.permissionNames()]
  const disposers: Array<() => void> = []
  const register = (definition: unknown): void => { disposers.push(agent.ctx.tools.register(definition)) }
  try {
    register(defineTool({
      name: 'automation_create',
      description: AUTOMATION_CREATE_DESCRIPTION,
      parameters: {
        name: { type: 'string', required: true },
        prompt: { type: 'string', required: true, description: 'Self-contained task instructions that each independent run can understand on its own.' },
        kind: { type: 'string', required: true, enum: ['once', 'interval', 'hourly', 'daily', 'weekly', 'monthly', 'custom'] },
        time_zone: { type: 'string', required: true, description: 'IANA time zone, e.g. Asia/Shanghai.' },
        at: { type: 'string', description: 'ISO 8601 timestamp with UTC offset for one-shot schedules.' },
        every_minutes: { type: 'integer', description: 'Run interval in minutes for interval schedules, minimum 5.' },
        minute: { type: 'integer', description: 'Minute of the hour for hourly schedules, 0-59.' },
        time: { type: 'string', description: 'Local wall-clock time HH:mm for daily, weekly, monthly, or custom schedules.' },
        weekdays: { type: 'array', items: { type: 'string', enum: WEEKDAYS } },
        month_day: { type: 'integer', description: 'Day of month for monthly schedules, 1-31.' },
        every_days: { type: 'integer', description: 'Run every N days for custom schedules, 1-365.' },
        permission: { type: 'string', enum: permissionNames },
        preset: { type: 'string', description: '可选 Agent preset ID；省略时使用 Host 默认 preset。' },
      },
      output: JSON_OUTPUT,
      async execute(args: CreateArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const value = await service.create(scope, {
            name: args.name,
            prompt: args.prompt,
            schedule: scheduleFromArgs(args, new Date().toISOString()),
            ...(args.permission === undefined ? {} : { permissionPreset: args.permission }),
            ...(args.preset === undefined ? {} : { agentPreset: args.preset }),
          }, exec.signal)
          return json({ ok: true, automation: value })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: CreateArgs) => present('Create automation', 'other', args.name),
    }))

    register(defineTool({
      name: 'automation_get',
      description: 'List scheduled automations in the current workspace. Omit id to get summaries; pass id for full details, optionally with include_runs to read its run history.',
      parameters: {
        id: { type: 'string', description: 'Optional automation ID.' },
        include_runs: { type: 'boolean', description: 'When id is given, also return its run history.' },
        status: { type: 'string', description: 'Optional run status filter.' },
      },
      output: JSON_OUTPUT,
      async execute(args: GetArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          const snapshot = await service.snapshot(scope, exec.signal)
          const definitions = args.id === undefined
            ? snapshot.definitions
            : snapshot.definitions.filter(item => item.id === args.id)
          const runs = args.id === undefined
            ? []
            : snapshot.runs.filter(item => item.automationId === args.id && (args.status === undefined || item.status === args.status))
          return json({
            ok: true,
            generatedAt: snapshot.generatedAt,
            workspace: snapshot.workspace,
            automations: definitions,
            ...(args.id === undefined || args.include_runs !== true ? {} : { runs }),
          })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: () => present('List automations', 'read'),
    }))

    register(defineTool({
      name: 'automation_manage',
      description: 'Manage an existing automation in the current workspace. Use action to update, pause, resume, run now, or delete it.',
      parameters: {
        id: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: ['update', 'pause', 'resume', 'run_now', 'delete'] },
        name: { type: 'string' },
        prompt: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] },
        kind: { type: 'string', enum: ['once', 'interval', 'hourly', 'daily', 'weekly', 'monthly', 'custom'] },
        time_zone: { type: 'string' },
        at: { type: 'string' },
        every_minutes: { type: 'integer' },
        minute: { type: 'integer' },
        time: { type: 'string' },
        weekdays: { type: 'array', items: { type: 'string', enum: WEEKDAYS } },
        month_day: { type: 'integer' },
        every_days: { type: 'integer' },
        permission: { type: 'string', enum: permissionNames },
        preset: { type: 'string', description: '更新任务使用的 Agent preset ID。' },
      },
      output: JSON_OUTPUT,
      async execute(args: ManageArgs, exec: ToolRunContext) {
        if (exec.agent !== agent || exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
        try {
          if (args.action === 'run_now') return json({ ok: true, run: await service.runNow(scope, args.id, exec.signal) })
          if (args.action === 'delete') return json({ ok: true, value: await service.delete(scope, args.id, exec.signal) })
          if (args.action === 'pause' || args.action === 'resume') {
            return json({ ok: true, automation: await service.update(scope, args.id, { status: args.action === 'pause' ? 'paused' : 'active' }, exec.signal) })
          }
          validateScheduleSelector(args)
          const input: {
            name?: string
            prompt?: string
            status?: 'active' | 'paused'
            schedule?: AutomationSchedule
            permissionPreset?: PermissionPreset
            agentPreset?: string
          } = {}
          if (args.name !== undefined) input.name = String(args.name)
          if (args.prompt !== undefined) input.prompt = String(args.prompt)
          if (args.status !== undefined) input.status = args.status
          if (args.permission !== undefined) input.permissionPreset = args.permission
          if (args.preset !== undefined) input.agentPreset = args.preset
          if (args.kind !== undefined) input.schedule = scheduleFromArgs(args, new Date().toISOString())
          if (Object.keys(input).length === 0) throw new Error('automation_manage update requires at least one field to change')
          const value = await service.update(scope, args.id, input, exec.signal)
          return json({ ok: true, automation: value })
        } catch (error: unknown) {
          if (exec.signal.aborted) return json({ ok: false, code: 'cancelled' })
          return json({ ok: false, code: 'automation_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      presentCall: (args: ManageArgs) => present('Manage automation', 'other', args.id),
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
