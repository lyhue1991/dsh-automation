/** 独立自动化的 Cordis Host 插件入口。 */
import type { Context } from '@deepseek-ai/cordis';
import { AutomationService } from './service.ts';
export declare const name = "dsh-automation";
export declare const inject: string[];
export interface Config {
    readonly maxConcurrentRuns?: number;
    readonly runTimeoutMinutes?: number;
    readonly misfireGraceMinutes?: number;
    readonly historyLimit?: number;
    readonly liveSessionLimit?: number;
    /** 不挂载管理工具的 agent preset id 列表；极简模式默认不提供自动化工具。 */
    readonly excludedAgentPresets?: string[];
}
export declare const Config: any;
export type SessionApprovalPolicy = 'ask' | 'never';
export interface ApprovalPolicyReader {
    readonly config?: {
        readonly policy?: SessionApprovalPolicy;
    };
    overrideOf?(session: unknown): SessionApprovalPolicy | undefined;
}
/** 读取当前会话实际审批策略；自定义权限预设也以 Host 投影结果为准。 */
export declare function sessionApprovalPolicy(approval: ApprovalPolicyReader | undefined, session: unknown): SessionApprovalPolicy | undefined;
/**
 * 只在实际 ask 策略下二次确认。never 策略再 ask，
 * 会被映射成 “the user rejected tool”，且不会弹窗。
 */
export declare function needsHumanApproval(exec: {
    readonly name: string;
    readonly arguments?: unknown;
    readonly signal: AbortSignal;
}, isMountedAgent: boolean, policy?: SessionApprovalPolicy): boolean;
export declare function humanApprovalReason(toolName: string, args?: unknown): string;
/**
 * 读取一个 agent 当前实际运行的 agent preset id。
 *
 * 优先读 live scope（`AgentPresets.composedPreset`），它对尚未写入
 * session header 的 agent（例如 header 还在构造中的子 agent）也能回答；
 * 回退到 session header 的创建期记录。两者都没有（未按 preset 组合的
 * 部署，如 ACP/headless）返回 undefined，此时不排除任何 agent。
 */
export declare function composedAgentPresetId(agentPresets: {
    composedPreset?: (agentCtx: unknown) => string | undefined;
} | undefined, agent: {
    readonly ctx?: unknown;
    readonly session?: {
        readonly header?: {
            readonly agentPreset?: string;
        };
    };
}): string | undefined;
export declare function mountAutomationRpc(ctx: Context, service: AutomationService): void;
export declare function apply(ctx: Context, rawConfig: Config): Promise<void>;
export type * from './types.ts';
export { automationDomainSpec } from './domain.ts';
