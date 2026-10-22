import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { AppError, type ErrorCode } from '@/lib/errors';
import { snapshotRuntimeValue } from '../durable/serialization';
import type { ToolExecutionResult } from './index';

const NEXT_ACTION: Record<ErrorCode, string> = {
  VALIDATION: 'Correct the specified parameters or ask the user for missing details.',
  NOT_FOUND: 'Query the available resources and ask the user to select a valid owned resource.',
  INSUFFICIENT_FUNDS: 'Explain the available funds and ask the user how to proceed. Do not change the amount or funding account automatically.',
  LIMIT_EXCEEDED: 'Explain the limit and ask the user how to proceed. Do not split or reduce the operation automatically.',
  SECURITY_DENIED: 'Explain that the operation is unavailable. Do not bypass the permission boundary.',
  MFA_FAILED: 'Use the existing verification interface. Never request verification credentials in chat.',
  CIRCUIT_OPEN: 'Ask the user to resolve the lock in the security interface.',
  MFA_LOCKED: 'Stop. The operation is locked after too many incorrect codes; ask the user to resolve the lock in the security interface and start a new operation.',
  CONFLICT: 'Read the current resource or recorded operation status before proposing a new operation.',
  TOOL_FAILED: 'Check the recorded outcome before proposing another write. Do not report success.',
  INTERNAL: 'The outcome has not been verified. Check saved operation records before retrying a write.',
};
const INTERNAL_ERROR = 'The banking service could not complete the request. Check the saved operation status.';
const INTERNAL_FIELDS = new Set(['userId', 'sessionId', 'idempotencyKey', 'operationKey', 'invocationId',
  'leaseOwner', 'leaseToken', 'runLeaseToken', 'requestDigest', 'commandDigest', 'responseJson', 'resultJson',
  'dispatchError', 'dispatchTaskId']);

/** Domain failures keep their code; infrastructure diagnostics never become model instructions. */
export function toolFailure(error: unknown): ToolExecutionResult {
  const failure = AppError.from(error);
  const detail = failure.detail;
  const candidates = failure.code === 'CONFLICT' && detail && typeof detail === 'object' && 'candidates' in detail && Array.isArray(detail.candidates)
    ? detail.candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object' || typeof candidate.name !== 'string') return [];
      return [{ name: candidate.name, ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
        ...(typeof candidate.phone === 'string' ? { phone: candidate.phone } : {}),
        ...(typeof candidate.bank === 'string' ? { bank: candidate.bank } : {}) }];
    }) : [];
  return { ok: false, errorCode: failure.code,
    error: failure.code === 'INTERNAL' ? INTERNAL_ERROR : failure.message,
    ...(candidates.length ? { errorDetails: { candidates } } : {}) };
}

/** Preserve financial values and complete result text while omitting server execution identities. */
export function modelBankingData(value: unknown): unknown {
  const copy = (item: unknown, field?: string): unknown => {
    if (typeof item === 'string' && (field === 'phone' || field === 'mobile')) {
      return /^\d{11}$/.test(item) ? `${item.slice(0, 3)}****${item.slice(-4)}` : item;
    }
    if (Array.isArray(item)) return item.map(entry => copy(entry));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !INTERNAL_FIELDS.has(key))
      .map(([key, entry]) => [key, copy(entry, key)]));
  };
  return copy(snapshotRuntimeValue(value));
}

/** Pi sends content to the model; details remain the complete structured UI and journal result. */
export function modelToolError(error: unknown): string {
  const failure = toolFailure(error);
  return JSON.stringify({ bankingError: { code: failure.errorCode, message: failure.error,
    nextAction: NEXT_ACTION[failure.errorCode!], retryable: false,
    ...(failure.errorDetails ? { details: modelBankingData(failure.errorDetails) } : {}) } });
}

/** Parse only the server-owned complete error envelope, never arbitrary error wording. */
export function parseModelToolError(text: string): ToolExecutionResult | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('bankingError' in value)) return;
  const error = value.bankingError;
  if (!error || typeof error !== 'object' || Array.isArray(error) || !('code' in error) || !('message' in error) ||
    typeof error.code !== 'string' || !Object.hasOwn(NEXT_ACTION, error.code) || typeof error.message !== 'string') return;
  return { ok: false, errorCode: error.code as ErrorCode, error: error.message };
}

export function toModelToolResult(result: ToolExecutionResult): AgentToolResult<unknown> {
  if (!result.ok) {
    const failure = toolFailure(new AppError(result.errorCode ?? 'TOOL_FAILED', result.error ?? 'The banking tool failed.'));
    const envelope = JSON.parse(modelToolError(new AppError(failure.errorCode!, failure.error!, result.errorDetails))) as {
      bankingError: Record<string, unknown>;
    };
    if (result.data !== undefined) envelope.bankingError.data = modelBankingData(result.data);
    if (result.summary) envelope.bankingError.summary = result.summary;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }],
      details: { ...result, ...failure } };
  }
  return { content: [{ type: 'text', text: result.summary ?? 'Operation completed.' },
    { type: 'text', text: JSON.stringify({ ok: true, data: modelBankingData(result.data) }) }], details: result.data };
}
