import type { SVGProps } from 'react';
type IconProps = SVGProps<SVGSVGElement>;
export declare function AutomationIcon(props: IconProps): JSX.Element;
export declare function PlusIcon(props: IconProps): JSX.Element;
export declare function RefreshIcon(props: IconProps): JSX.Element;
export declare function PlayIcon(props: IconProps): JSX.Element;
export declare function PauseIcon(props: IconProps): JSX.Element;
export declare function TrashIcon(props: IconProps): JSX.Element;
export declare function ShieldIcon(props: IconProps): JSX.Element;
export declare function CalendarIcon(props: IconProps): JSX.Element;
export declare function CheckIcon(props: IconProps): JSX.Element;
export declare function AlertIcon(props: IconProps): JSX.Element;
export declare function MoreIcon(props: IconProps): JSX.Element;
export declare function InfoIcon(props: IconProps): JSX.Element;
export declare function ClockIcon(props: IconProps): JSX.Element;
export declare function ChatIcon(props: IconProps): JSX.Element;
export declare function FolderIcon(props: IconProps): JSX.Element;
export declare function SparkleIcon(props: IconProps): JSX.Element;
export declare function CloseOutlineIcon(props: IconProps): JSX.Element;
export declare function CheckOutlineIcon(props: IconProps): JSX.Element;
export declare function SearchOutlineIcon(props: IconProps): JSX.Element;
export declare function SlidersIcon(props: IconProps): JSX.Element;
export declare function FolderClosedIcon(props: IconProps): JSX.Element;
export declare function FolderOpenIcon(props: IconProps): JSX.Element;
export declare function PlayOutlineIcon(props: IconProps): JSX.Element;
export declare function TreeCornerIcon(props: IconProps): JSX.Element;
export declare function ChevronIcon(props: IconProps): JSX.Element;
/**
 * 官方 DSH ChevronDown 的本地副本（0.1.7 起宿主导出从 `IconChevronDownOutline14`
 * 改名为 `IconChevronDownOutlineRegular`，这里自带一份避免跟随宿主改名崩掉整个侧栏）。
 */
export declare function ChevronDownIcon({ size, className }: {
    readonly size?: number;
    readonly className?: string;
}): JSX.Element;
export declare function EllipsisIcon(props: IconProps): JSX.Element;
export declare function PencilIcon(props: IconProps): JSX.Element;
export declare function BranchIcon(props: IconProps): JSX.Element;
/** Official DSH IconAgentPresetOutline16, kept local for older primitives versions. */
export declare function PresetIcon({ width, height, ...props }: IconProps): JSX.Element;
export declare function ArchiveIcon(props: IconProps): JSX.Element;
/** 复刻官方任务树 running StateDot：3x3 像素绕圈。 */
export declare function RunningStateDot(): JSX.Element;
export {};
