import { AppError } from '@/lib/errors';
import { normalizeTransferAmount } from '@/lib/money';

/** Supported future payments use the same simulated transfer rail and authorization as immediate payments. */
export function scheduledTransferArgs(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'TRANSFER' && kind !== 'PAYMENT') {
    throw new AppError('VALIDATION', 'The scheduled command kind is unsupported.');
  }
  const selectors = {
    ...(typeof payload.contactId === 'string' ? { contactId: payload.contactId } : {}),
    ...(typeof payload.phone === 'string' ? { phone: payload.phone } : {}),
    ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
  };
  if (!Object.values(selectors).some(value => value.trim().length > 0)) {
    throw new AppError('VALIDATION', 'A scheduled payment requires an explicit recipient.');
  }
  if (payload.toolName !== undefined || payload.code !== undefined || payload.mfaCode !== undefined) {
    throw new AppError('VALIDATION', 'A scheduled payload cannot provide tools, executable code, or verification credentials.');
  }
  return {
    ...selectors,
    amount: normalizeTransferAmount(payload.amount),
    ...(typeof payload.sourceAccountId === 'string' ? { sourceAccountId: payload.sourceAccountId } : {}),
    ...(typeof payload.remark === 'string' ? { remark: payload.remark } : {}),
  };
}
