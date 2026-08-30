/** 已认领 run 的独立 Agent 执行边界。 */
import type { Context } from '@deepseek-ai/cordis';
import type { PermissionPresetService } from './permission-presets.ts';
import type { AutomationDefinition, AutomationRun } from './types.ts';
interface SessionEventLike {
    readonly seq: number;
    readonly type: string;
    readonly data: Record<string, any>;
}
/** 对不保证及时响应 AbortSignal 的宿主任务设置第二道退出上限。 */
export declare function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean>;
export declare function unattendedToolGuardReason(name: string, args: unknown): string | undefined;
export interface RunCompletion {
    readonly sessionId?: string;
    readonly status: 'succeeded' | 'failed' | 'cancelled';
    readonly summary?: string;
    readonly error?: {
        readonly code: string;
        readonly message: string;
    };
}
export interface ExecutorConfig {
    readonly runTimeoutMs: number;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
    readonly onHandleDisposed?: (sessionId: string) => void;
    /**
     * 终态后不 dispose，把 Agent 转成交互会话并通过 onHandleKept 移交调用方持有。
     * Web 客户端把 session/disposed 视为页面生命周期内的永久下线（removed 标记
     * 不复位），dispose 会让刚跑完的会话立刻变成“会话不可用”，只能刷新恢复。
     * 服务停止（signal abort）时仍由执行器自行清理，不走该路径。
     */
    readonly keepSessionOnCompletion?: boolean;
    readonly onHandleKept?: (sessionId: string, handle: AgentHandle) => void;
}
type AgentHandle = Awaited<ReturnType<Context['agents']['create']>>;
/** 从持久化日志恢复一个已完成的自动化会话，供用户继续交互。 */
export declare function resumeAutomationSession(ctx: Context, target: AutomationRun['targetSnapshot'], sessionId: string, ownerCtx?: Context): Promise<Awaited<ReturnType<Context['agents']['resume']>>>;
/** 先应用官方预设的完整语义，再让无人值守审批 fail-closed。 */
export declare function applyUnattendedPermission(presets: PermissionPresetService, session: unknown, permission: AutomationDefinition['permissionPreset']): void;
/** 运行结束后解除无人值守限制，让该 Agent 可以继续被用户交互。 */
export declare function convertRunAgentToInteractive(handle: Pick<AgentHandle, 'agent'>, removeToolGuard: (() => void) | undefined): void;
export declare function summarizeRun(events: readonly SessionEventLike[], firstSeq: number): {
    readonly text: string;
    readonly reason?: Record<string, any>;
};
export declare function executeAutomationRun(ctx: Context, definition: AutomationDefinition, run: AutomationRun, config: ExecutorConfig): Promise<RunCompletion>;
export declare function pinAutomationSessionTitle(ctx: Context, session: unknown, title: string): void;
export {};
