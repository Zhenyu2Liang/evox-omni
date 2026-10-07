/**
 * Banking SDK — execution-fence carrier.
 *
 * The SDK executes banking writes; it must NOT know anything about plans, execution tokens or
 * security policy. But a caller (the agent layer) sometimes needs to GUARANTEE that a write is still
 * authorized at the instant it commits — e.g. a plan that was taken over / cancelled while the tool
 * call was in flight must not commit its side effect.
 *
 * This module is the transport for that guarantee, and nothing more: an opaque async CHECK carried
 * on the input object itself. `banking-sdk` simply `await`s the check INSIDE the write transaction,
 * immediately before the business write, so a check that throws rolls the transaction back and NO
 * business row is persisted. The check is bound to the transaction's own client so it can read/assert
 * within the same atomic unit.
 *
 * The carrier is a NON-ENUMERABLE Symbol-keyed property, so it cannot be injected through JSON /
 * tool arguments (a model can never attach one) and never leaks into serialization.
 */
import type { Prisma } from '@prisma/client';

/** The check awaited INSIDE a write transaction, bound to that transaction's client. */
export type ExecutionFenceCheck = (client: Prisma.TransactionClient) => Promise<void>;

/** Non-enumerable symbol property carrying the fence on the input object; cannot be injected via JSON. */
export const EXECUTION_FENCE = Symbol('banking.executionFence');

/** Attach `check` to `input` as a NON-ENUMERABLE Symbol-keyed prop; returns the SAME object reference. */
export function attachExecutionFence<T extends object>(input: T, check: ExecutionFenceCheck): T {
  Object.defineProperty(input, EXECUTION_FENCE, {
    value: check,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return input;
}

/** Read the carried fence, or undefined. */
export function readExecutionFence(input: object): ExecutionFenceCheck | undefined {
  const value = (input as { [EXECUTION_FENCE]?: unknown })[EXECUTION_FENCE];
  return typeof value === 'function' ? (value as ExecutionFenceCheck) : undefined;
}
