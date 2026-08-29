import type { Translate } from './contracts.js';
export declare function DeleteConfirmation({ target, t, busy, error, onCancel, onConfirm, }: {
    readonly target: {
        readonly id: string;
        readonly name: string;
    } | undefined;
    readonly t: Translate;
    readonly busy: boolean;
    readonly error?: string;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
}): JSX.Element | null;
