import { AppError } from '@/lib/errors';
import { normalizeTransferAmount } from '@/lib/money';

/** Validate future payments before persistence and again at dispatch. */
export function scheduledTransferArgs(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'TRANSFER' && kind !== 'PAYMENT') {
    throw new AppError('VALIDATION', 'The scheduled command kind is unsupported.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION', 'A scheduled payment payload must be an object.');
  }
  const allowed = new Set(['contactId', 'phone', 'name', 'amount', 'sourceAccountId', 'remark']);
  if (Object.keys(payload).some(key => !allowed.has(key))) {
    throw new AppError('VALIDATION', 'A scheduled payment contains unsupported fields.');
  }
  const selectors = ['contactId', 'phone', 'name'].filter(key => payload[key] !== undefined);
  if (selectors.length !== 1 || typeof payload[selectors[0]] !== 'string' || !(payload[selectors[0]] as string).trim()) {
    throw new AppError('VALIDATION', 'A scheduled payment requires exactly one explicit recipient.');
  }
  for (const field of ['sourceAccountId', 'remark']) {
    if (payload[field] !== undefined && (typeof payload[field] !== 'string' || field === 'sourceAccountId' && !(payload[field] as string).trim())) {
      throw new AppError('VALIDATION', 'Scheduled account and remark fields must be valid text.');
    }
  }
  if (typeof payload.amount !== 'string') {
    throw new AppError('VALIDATION', 'Scheduled payment amount must be decimal text.');
  }
  return { ...payload, amount: normalizeTransferAmount(payload.amount) };
}

/** Reminder payloads contain inert display text, never executable commands. */
export function validateScheduledPayload(kind: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (kind === 'TRANSFER' || kind === 'PAYMENT') return scheduledTransferArgs(kind, payload ?? {});
  if (kind !== 'REMINDER') throw new AppError('VALIDATION', 'The scheduled command kind is unsupported.');
  if (payload === undefined) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION', 'A reminder payload must be an object.');
  }
  if (Object.keys(payload).some(key => key !== 'note') || payload.note !== undefined && typeof payload.note !== 'string') {
    throw new AppError('VALIDATION', 'A reminder payload may contain only a text note.');
  }
  return payload;
}
