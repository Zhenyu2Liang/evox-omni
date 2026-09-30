/**
 * Banking SDK — money movement (EXECUTE ONLY).
 *
 * The SDK here only validates & executes: it resolves the recipient, checks funds and writes the
 * DEBIT transaction. It does NOT decide permission, confirmation or daily-limit policy — that is
 * the Security Gateway's job (`security/`) and MUST NOT be implemented here.
 *
 * Throws `AppError`:
 *  - `VALIDATION`        — missing/invalid recipient or non-positive amount.
 *  - `NOT_FOUND`         — no contact matches the given id/phone/name.
 *  - `CONFLICT`          — a name matches multiple contacts (`detail.candidates` lists them).
 *  - `INSUFFICIENT_FUNDS`— funding account balance < amount.
 */
import type { TransferInput, TransferResult } from './types';

/** Execute a transfer: resolve recipient, verify funds, write the DEBIT transaction. */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  throw new Error('not implemented');
}
