/** 已认领 run 的独立 Agent 执行边界。 */

import { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { automationSessionTitle } from './run-title.ts'
import type { PermissionPresetService } from './permission-presets.ts'
import type { AutomationDefinition, AutomationRun } from './types.ts'

interface TextBlock { readonly type: string; readonly text?: string }
interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, any>
}

const UNATTENDED_TOOL_ALLOWLIST = new Set([
  'run_code',
  'bash', 'bash_io', 'pwsh',
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'find', 'glob', 'grep', 'ls', 'lsp',
  'web_search', 'web_fetch',
  'skill', 'create_goal', 'get_goal', 'update_goal',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
])
const CANCEL_CONVERGENCE_TIMEOUT_MS = 10_000

/** 对不保证及时响应 AbortSignal 的宿主任务设置第二道退出上限。 */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function unattendedToolGuardReason(name: string, args: unknown): string | undefined {
  if ((name === 'bash' || name === 'pwsh')
    && typeof args === 'object' && args !== null
    && (args as Record<string, unknown>).run_in_background === true) {
    return 'Unattended runs are not allowed to start background processes.'
  }
  return UNATTENDED_TOOL_ALLOWLIST.has(name)
    ? undefined
    : `Tool '${name}' is not in the unattended automation allowlist.`
}

export interface RunCompletion {
  readonly sessionId?: string
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly summary?: string
  readonly error?: { readonly code: string; readonly message: string }
}

export interface ExecutorConfig {
  readonly runTimeoutMs: number
  readonly sessionId: string
  readonly signal?: AbortSignal
  readonly onHandleDisposed?: (sessionId: string) => void
  /**
   * 终态后不 dispose，把 Agent 转成交互会话并通过 onHandleKept 移交调用方持有。
   * Web 客户端把 session/disposed 视为页面生命周期内的永久下线（removed 标记
   * 不复位），dispose 会让刚跑完的会话立刻变成“会话不可用”，只能刷新恢复。
   * 服务停止（signal abort）时仍由执行器自行清理，不走该路径。
   */
  readonly keepSessionOnCompletion?: boolean
  readonly onHandleKept?: (sessionId: string, handle: AgentHandle) => void
}

type AgentHandle = Awaited<ReturnType<Context['agents']['create']>>

/** 从持久化日志恢复一个已完成的自动化会话，供用户继续交互。 */
export async function resumeAutomationSession(
  ctx: Context,
  target: AutomationRun['targetSnapshot'],
  sessionId: string,
  ownerCtx: Context = ctx,
): Promise<Awaited<ReturnType<Context['agents']['resume']>>> {
  const fallbackSelection = ctx.agentDefaultModel.currentSelection()
  const selection: ModelSelection = target.provider !== null && target.model !== null
    ? {
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      }
    : fallbackSelection
  const resume = (): ReturnType<Context['agents']['resume']> => ownerCtx.agents.resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: Context) => {
      await ctx.agentPresets.mount(agentCtx, target.agentPreset)
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('automation resume has no scoped Agent')
      ctx.permissionPresets.set(agent.session, target.permissionPreset)
      // 恢复后的会话属于用户交互，不继承无人值守运行的 never 策略。
      setApprovalPolicy(agent.session, 'ask')
    },
  })
  // A history open is a new user-owned root interaction, never a continuation
  // of whichever Agent happened to initiate the RPC request.
  return typeof ownerCtx.agents.withoutInitiator === 'function'
    ? ownerCtx.agents.withoutInitiator(resume)
    : resume()
}

/** 先应用官方预设的完整语义，再让无人值守审批 fail-closed。 */
export function applyUnattendedPermission(
  presets: PermissionPresetService,
  session: unknown,
  permission: AutomationDefinition['permissionPreset'],
): void {
  presets.set(session, permission)
  setApprovalPolicy(session, 'never')
}

/** 运行结束后解除无人值守限制，让该 Agent 可以继续被用户交互。 */
export function convertRunAgentToInteractive(
  handle: Pick<AgentHandle, 'agent'>,
  removeToolGuard: (() => void) | undefined,
): void {
  try {
    removeToolGuard?.()
  } catch {
    // guard 所属的 agent scope 已自行卸载时忽略。
  }
  setApprovalPolicy(handle.agent.session, 'ask')
}

export function summarizeRun(events: readonly SessionEventLike[], firstSeq: number): {
  readonly text: string
  readonly reason?: Record<string, any>
} {
  let started = false
  let text = ''
  let reason: Record<string, any> | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const blocks = (event.data.message?.content ?? []) as readonly TextBlock[]
      const joined = blocks.filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason as Record<string, any>
  }
  return { text, ...(reason === undefined ? {} : { reason }) }
}

function boundSummary(value: string): string | undefined {
  const normalized = value.trim()
  if (normalized === '') return undefined
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_999)}…`
}

function reasonError(reason: Record<string, any> | undefined): { readonly code: string; readonly message: string } {
  if (reason === undefined) return { code: 'no_turn_result', message: 'This automation run did not produce a complete turn.' }
  if (reason.kind === 'error') {
    return {
      code: typeof reason.error?.code === 'string' ? reason.error.code : 'agent_error',
      message: typeof reason.error?.message === 'string'
        ? reason.error.message
        : 'The automation agent failed to execute.',
    }
  }
  return { code: `turn_${String(reason.kind)}`, message: `The automation ended with reason ${String(reason.kind)}.` }
}

export async function executeAutomationRun(
  ctx: Context,
  definition: AutomationDefinition,
  run: AutomationRun,
  config: ExecutorConfig,
): Promise<RunCompletion> {
  if (config.signal?.aborted === true) {
    return { status: 'cancelled', error: { code: 'cancelled', message: 'The automation was cancelled before it started.' } }
  }
  const target = run.targetSnapshot
  const workspace = ctx.workspaceRegistry.get(WorkspaceId(target.workspaceId))
  if (workspace === undefined) {
    return { status: 'failed', error: { code: 'workspace_not_found', message: 'The target workspace no longer exists.' } }
  }
  if (await workspace.status() !== 'ok' || workspace.path !== target.cwd) {
    return { status: 'failed', error: { code: 'workspace_unavailable', message: 'The target workspace directory is unavailable or has changed.' } }
  }

  const fallbackSelection = ctx.agentDefaultModel.currentSelection()
  const selection: ModelSelection = target.provider !== null && target.model !== null
    ? {
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      }
    : fallbackSelection
  const sessionId = SessionId(config.sessionId)
  let handle: AgentHandle | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeCancellationListener = () => {}
  let removeToolGuard: (() => void) | undefined
  let handedOff = false
  try {
    handle = await ctx.agents.withoutInitiator(() => ctx.agents.create({
      sessionId,
      ...(config.signal === undefined ? {} : { signal: config.signal }),
      meta: { cwd: target.cwd, agentPreset: target.agentPreset },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx: Context) => {
        await ctx.agentPresets.mount(agentCtx, target.agentPreset)
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        const agent = agentCtx.agent
        if (agent === undefined) throw new Error('automation setup has no scoped Agent')
        applyUnattendedPermission(ctx.permissionPresets, agent.session, target.permissionPreset)
        removeToolGuard = agentCtx.tools.guard((exec: ToolExecution) => unattendedToolGuardReason(exec.name, exec.arguments))
      },
    }))
    await handle.agent.whenIdle()
    await workspace.attachSession(sessionId)
    pinAutomationSessionTitle(ctx, handle.agent.session, automationSessionTitle(definition.name, run.startedAt ?? run.scheduledFor))
    const firstSeq = handle.agent.session.seq
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: run.promptSnapshot }],
      source: {
        kind: 'automation',
        automationId: definition.id,
        runId: run.id,
        scheduledFor: run.scheduledFor,
      },
    }))

    let timedOut = false
    let aborted = false
    const idle = handle.agent.whenIdle()
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true
        handle?.agent.cancel({ kind: 'hook', reason: 'automation run timeout' })
        resolve()
      }, config.runTimeoutMs)
    })
    const cancellation = new Promise<void>((resolve) => {
      if (config.signal === undefined) return
      const cancel = () => {
        aborted = true
        handle?.agent.cancel({ kind: 'hook', reason: 'automation service disposed' })
        resolve()
      }
      if (config.signal.aborted) cancel()
      else {
        config.signal.addEventListener('abort', cancel, { once: true })
        removeCancellationListener = () => { config.signal?.removeEventListener('abort', cancel) }
      }
    })
    await Promise.race([idle, deadline, cancellation])
    removeCancellationListener()
    if ((timedOut || aborted) && !await settlesWithin(idle, CANCEL_CONVERGENCE_TIMEOUT_MS)) {
      return {
        sessionId: String(sessionId),
        status: aborted ? 'cancelled' : 'failed',
        error: {
          code: 'cancel_convergence_timeout',
          message: 'The automation did not stop within the safety deadline after cancellation.',
        },
      }
    }
    if (timeout !== undefined) clearTimeout(timeout)
    await ctx.sessions.flush(handle.agent.session)
    const outcome = summarizeRun(handle.agent.session.events, firstSeq)
    const summary = boundSummary(outcome.text)
    const completion: RunCompletion = aborted
      ? {
          sessionId: String(sessionId),
          status: 'cancelled',
          ...(summary === undefined ? {} : { summary }),
          error: { code: 'cancelled', message: 'The automation was cancelled because its owning service stopped.' },
        }
      : timedOut
        ? {
            sessionId: String(sessionId),
            status: 'failed',
            ...(summary === undefined ? {} : { summary }),
            error: { code: 'timeout', message: 'The automation exceeded the maximum run time limit.' },
          }
        : outcome.reason?.kind === 'completed'
          ? { sessionId: String(sessionId), status: 'succeeded', ...(summary === undefined ? {} : { summary }) }
          : {
              sessionId: String(sessionId),
              status: 'failed',
              ...(summary === undefined ? {} : { summary }),
              error: reasonError(outcome.reason),
            }
    if (config.keepSessionOnCompletion === true && !aborted) {
      // 交给服务保活的句柄必须在移交前转成交互语义；移交失败则走原 dispose 兜底。
      convertRunAgentToInteractive(handle, removeToolGuard)
      removeToolGuard = undefined
      config.onHandleKept?.(String(sessionId), handle)
      handedOff = true
    }
    return completion
  } catch (error: unknown) {
    return {
      ...(handle === undefined ? {} : { sessionId: String(sessionId) }),
      status: 'failed',
      error: {
        code: 'executor_error',
        message: error instanceof Error ? error.message : 'The automation executor failed.',
      },
    }
  } finally {
    removeCancellationListener()
    if (timeout !== undefined) clearTimeout(timeout)
    if (handle !== undefined && !handedOff) {
      config.onHandleDisposed?.(String(sessionId))
      await settlesWithin(handle.dispose().catch(() => {}), CANCEL_CONVERGENCE_TIMEOUT_MS)
    }
  }
}

export function pinAutomationSessionTitle(ctx: Context, session: unknown, title: string): void {
  // Cordis 未 inject 时直接读 ctx.sessionTitle 会抛错，必须走可选查询。
  const service = ctx.get('sessionTitle') as { rename?(target: unknown, value: string): unknown } | undefined
  if (service === undefined || typeof service.rename !== 'function') return
  try {
    service.rename(session, title)
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-automation: failed to pin session title: ${error instanceof Error ? error.message : String(error)}`)
  }
}
