/** 独立自动化的 Cordis Host 插件入口。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { readSessionEvents } from './executor.ts'
import { AUTOMATION_PROMPT_NAME, AUTOMATION_PROMPT_ORDER, AUTOMATION_PROMPT_TEXT } from './prompt.ts'
import { registerAutomationRpc, type RpcContext } from './rpc.ts'
import { AutomationService } from './service.ts'
import { registerAutomationTools } from './tools.ts'

export const name = 'dsh-automation'
export const inject = [
  'storageDomain', 'agents', 'sessions', 'workspaceRegistry', 'agentDefaultModel',
  'agentPresets', 'permissionPresets', 'tools', 'connection', 'llm', 'sessionPersistence',
]

export interface Config {
  readonly maxConcurrentRuns?: number
  readonly runTimeoutMinutes?: number
  readonly misfireGraceMinutes?: number
  readonly historyLimit?: number
  readonly liveSessionLimit?: number
  /** 不挂载管理工具的 agent preset id 列表；极简模式默认不提供自动化工具。 */
  readonly excludedAgentPresets?: string[]
}

export const Config = z.object({
  maxConcurrentRuns: z.number().step(1).min(1).max(32).default(4),
  runTimeoutMinutes: z.number().step(1).min(1).max(1_440).default(60),
  misfireGraceMinutes: z.number().step(1).min(0).max(10_080).default(15),
  historyLimit: z.number().step(1).min(1).max(5_000).default(200),
  liveSessionLimit: z.number().step(1).min(0).max(1_000).default(20),
  excludedAgentPresets: z.array(z.string()).default(['minimal']),
})

const MUTATING_TOOLS = new Set([
  'automation_create', 'automation_manage',
])

interface DynamicInjectionContext extends Context {
  inject(services: readonly ['webServer'], callback: (webContext: Context) => void): unknown
}

export type SessionApprovalPolicy = 'ask' | 'never'

export interface ApprovalPolicyReader {
  readonly config?: { readonly policy?: SessionApprovalPolicy }
  overrideOf?(session: unknown): SessionApprovalPolicy | undefined
}

/** 读取当前会话实际审批策略；自定义权限预设也以 Host 投影结果为准。 */
export function sessionApprovalPolicy(
  approval: ApprovalPolicyReader | undefined,
  session: unknown,
): SessionApprovalPolicy | undefined {
  const override = approval?.overrideOf?.(session)
  if (override === 'ask' || override === 'never') return override
  const fallback = approval?.config?.policy
  if (fallback === 'ask' || fallback === 'never') return fallback
  return undefined
}

/**
 * 只在实际 ask 策略下二次确认。never 策略再 ask，
 * 会被映射成 “the user rejected tool”，且不会弹窗。
 */
export function needsHumanApproval(
  exec: { readonly name: string; readonly arguments?: unknown; readonly signal: AbortSignal },
  isMountedAgent: boolean,
  policy?: SessionApprovalPolicy,
): boolean {
  if (!isMountedAgent || exec.signal.aborted || !MUTATING_TOOLS.has(exec.name)) return false
  if (policy !== 'ask') return false
  if (exec.name !== 'automation_manage') return true
  const args = typeof exec.arguments === 'object' && exec.arguments !== null
    ? exec.arguments as Record<string, unknown>
    : {}
  return args.action !== 'pause' || Object.keys(args).some(key => key !== 'id' && key !== 'action')
}

export function humanApprovalReason(toolName: string, args?: unknown): string {
  const action = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).action : undefined
  return toolName === 'automation_manage' && action === 'delete'
    ? 'This permanently deletes the automation definition. Run history is kept, but the schedule cannot be restored automatically.'
    : 'This creates or expands unattended future work. Review the task prompt, schedule, workspace, and permission boundary before approving.'
}

/**
 * 读取一个 agent 当前实际运行的 agent preset id。
 *
 * 优先读 live scope（`AgentPresets.composedPreset`），它对尚未写入
 * session header 的 agent（例如 header 还在构造中的子 agent）也能回答；
 * 回退到 session header 的创建期记录。两者都没有（未按 preset 组合的
 * 部署，如 ACP/headless）返回 undefined，此时不排除任何 agent。
 */
export function composedAgentPresetId(
  agentPresets: { composedPreset?: (agentCtx: unknown) => string | undefined } | undefined,
  agent: {
    readonly ctx?: unknown
    readonly session?: { readonly header?: { readonly agentPreset?: string } }
  },
): string | undefined {
  const live = agentPresets?.composedPreset?.(agent.ctx)
  if (typeof live === 'string' && live !== '') return live
  const header = agent.session?.header?.agentPreset
  return typeof header === 'string' && header !== '' ? header : undefined
}

export function mountAutomationRpc(ctx: Context, service: AutomationService): void {
  const dynamicContext = ctx as DynamicInjectionContext
  dynamicContext.inject(['webServer'], webCtx => {
    webCtx.effect(
      () => registerAutomationRpc(webCtx as unknown as RpcContext, service),
      'dsh-automation: Web RPC',
    )
  })
}

export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = rawConfig as Required<Config>
  await ctx.effect(async () => {
    let alive = true
    const service = await AutomationService.open(ctx, {
      maxConcurrentRuns: config.maxConcurrentRuns,
      runTimeoutMs: config.runTimeoutMinutes * 60_000,
      misfireGraceMs: config.misfireGraceMinutes * 60_000,
      historyLimit: config.historyLimit,
      liveSessionLimit: config.liveSessionLimit,
    })
    const agentTools = new Map<object, () => void | Promise<void>>()
    let cleaned = false
    let stopCreated = () => {}
    let stopDisposed = () => {}
    let stopApproval = () => {}
    let stopPrompt = () => {}
    let stopPresetSelected = () => {}
    let stopSessionGone = () => {}
    const excludedPresets = new Set(config.excludedAgentPresets)
    const presetOf = (agent: any): string | undefined =>
      composedAgentPresetId(ctx.agentPresets as never, agent)
    const isExcluded = (agent: any): boolean => {
      const preset = presetOf(agent)
      return preset !== undefined && excludedPresets.has(preset)
    }
    const cleanup = async (): Promise<void> => {
      if (cleaned) return
      cleaned = true
      alive = false
      for (const stop of [stopCreated, stopDisposed, stopApproval, stopPrompt, stopPresetSelected, stopSessionGone]) {
        try { stop() } catch (error: unknown) {
          ctx.logger.warn(`dsh-automation: lifecycle cleanup failed: ${String(error)}`)
        }
      }
      const results = await Promise.allSettled(
        [...agentTools.values()].reverse().map(dispose => Promise.resolve().then(dispose)),
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          ctx.logger.warn(`dsh-automation: contribution cleanup failed: ${String(result.reason)}`)
        }
      }
      agentTools.clear()
      await service.dispose()
    }

    try {
      const mountTools = (agent: any): void => {
        if (!alive || agentTools.has(agent)
          || service.ownsSession(String(agent.id), readSessionEvents(agent.session, 0))) return
        if (!ctx.agents.roots().includes(agent)) return
        if (isExcluded(agent)) return
        const dispose = agent.ctx.effect(
          () => registerAutomationTools(service, agent),
          'dsh-automation: management tools',
        )
        agentTools.set(agent, dispose)
      }
      for (const agent of ctx.agents.roots()) mountTools(agent)
      stopCreated = ctx.on('agent/created', ({ agent }: any) => {
        mountTools(agent)
        return Promise.resolve()
      })
      stopDisposed = ctx.on('agent/disposed', ({ agent }: any) => {
        agentTools.delete(agent)
        return Promise.resolve()
      })
      // 空白会话可以在开始前切换 preset（agent-preset/selected）；此时
      // 之前注册的工具要拆掉、被排除 preset 的工具要补挂，保持“模型可见
      // ⟺ 已注册”一致。切换到被排除的 preset 时立即卸载，反向切换则
      // 通过 mountTools 的完整守卫重新挂载。
      stopPresetSelected = ctx.on('agent-preset/selected', (sessionId: unknown, _agentPreset: unknown) => {
        const agent = ctx.agents.roots().find((candidate: any) => String(candidate.id) === String(sessionId))
        if (agent === undefined) return Promise.resolve()
        if (isExcluded(agent)) {
          const dispose = agentTools.get(agent)
          if (dispose !== undefined) {
            agentTools.delete(agent)
            void Promise.resolve().then(dispose).catch((error: unknown) => {
              ctx.logger.warn(`dsh-automation: preset switch cleanup failed: ${String(error)}`)
            })
          }
        } else {
          mountTools(agent)
        }
        return Promise.resolve()
      })
      stopSessionGone = ctx.on('session/disposed', (session: { readonly id?: string }) => {
        const id = String(session?.id ?? '')
        if (id === '') return Promise.resolve()
        return service.forgetSession(id)
      })
      const systemPrompt = ctx.get('systemPrompt') as { section?(input: { name: string; order: number; text: string }): () => void } | undefined
      if (typeof systemPrompt?.section === 'function') {
        stopPrompt = systemPrompt.section({
          name: AUTOMATION_PROMPT_NAME,
          order: AUTOMATION_PROMPT_ORDER,
          text: AUTOMATION_PROMPT_TEXT,
        })
      }
      stopApproval = ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
        const downstream = await next()
        const approval = ctx.get('approval') as ApprovalPolicyReader | undefined
        const policy = sessionApprovalPolicy(approval, exec.agent?.session)
        if (downstream.kind !== 'allow' || !needsHumanApproval(exec, agentTools.has(exec.agent), policy)) {
          return downstream
        }
        return {
          kind: 'ask' as const,
          reason: humanApprovalReason(exec.name, exec.arguments),
        }
      })
      mountAutomationRpc(ctx, service)

      const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
      if (loader === undefined) service.start()
      else {
        void loader.await().then(() => {
          if (alive) service.start()
        }, (error: unknown) => {
          if (alive) ctx.logger.warn(`dsh-automation: Loader did not settle; clock remains stopped: ${String(error)}`)
        })
      }

      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  }, 'dsh-automation: host service')
}

export type * from './types.ts'
export { automationDomainSpec } from './domain.ts'
