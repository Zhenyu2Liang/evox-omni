import type { BadgeProps } from '../../ui';

/** The `ui/Badge` tone union, reused so a status never hard-codes a colour. */
export type BadgeTone = NonNullable<BadgeProps['tone']>;

/**
 * The SETTLED (terminal) outcomes of a gated action — an outcome the server has already committed,
 * so a confirmation card must stop offering 取消/确认 and instead state the fact.
 */
export type TerminalActionStatus = 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation';

const TERMINAL_STATUSES: readonly TerminalActionStatus[] = [
  'executed',
  'failed',
  'cancelled',
  'locked',
  'needs_reconciliation',
];

/** Type guard for the terminal outcomes (unknown in, narrows to `TerminalActionStatus`). */
export function isTerminalStatus(value: unknown): value is TerminalActionStatus {
  return typeof value === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

/** Narrows an unknown runtime value to a terminal status, else `undefined` (non-terminal / absent). */
export function asTerminalStatus(value: unknown): TerminalActionStatus | undefined {
  return isTerminalStatus(value) ? value : undefined;
}

/** The badge tone + label (+ optional one-line explanation) a terminal status renders as. */
export interface TerminalStatusView {
  tone: BadgeTone;
  label: string;
  explanation?: string;
}

/** Standard one-liner for the UNKNOWN-outcome reconciliation state. */
export const RECONCILIATION_EXPLANATION = '该操作结果未能确认，需人工核对处理。';

/** Exhaustiveness guard: a new `TerminalActionStatus` variant must break the build here. */
function assertNever(x: never): never {
  throw new Error('Unhandled terminal action status: ' + JSON.stringify(x));
}

/**
 * Maps a terminal status to its rendered badge. `reason` is used ONLY by `failed` (omitted entirely
 * when blank); `needs_reconciliation` always carries its standard explanation.
 */
export function terminalStatusView(
  status: TerminalActionStatus,
  reason?: string,
): TerminalStatusView {
  switch (status) {
    case 'executed':
      return { tone: 'success', label: '已执行' };
    case 'failed': {
      const trimmed = reason?.trim();
      return trimmed
        ? { tone: 'danger', label: '失败', explanation: trimmed }
        : { tone: 'danger', label: '失败' };
    }
    case 'cancelled':
      return { tone: 'neutral', label: '已取消' };
    case 'locked':
      return { tone: 'danger', label: 'Locked' };
    case 'needs_reconciliation':
      return { tone: 'warn', label: '需人工核对', explanation: RECONCILIATION_EXPLANATION };
    default:
      return assertNever(status);
  }
}
