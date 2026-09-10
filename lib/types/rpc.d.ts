/** 仅 loopback 的 Web 客户端 RPC 适配器。 */
import { type AutomationService } from './service.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface RpcContext {
    readonly logger: {
        warn(message: string): void;
    };
    readonly connection: {
        requestRejection(request: unknown): 401 | 403 | undefined;
        readonly rpc: {
            handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, options: {
                readonly authority: 'loopback' | 'trusted-host';
            }): () => Promise<void>;
        };
    };
    effect(register: () => (() => void) | void, label: string): () => Promise<void>;
    readonly webServer: {
        register(route: {
            readonly kind: 'prefix';
            readonly path: string;
            readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): () => void;
    };
}
export declare function registerAutomationRpc(ctx: RpcContext, service: AutomationService): () => Promise<void>;
