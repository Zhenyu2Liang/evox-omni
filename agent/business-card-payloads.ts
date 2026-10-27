/** Validate and project public tool evidence before adding it to persisted chat cards. */
import type { BusinessReceipt, ContactCardView, DashboardCardView, ScheduledCardView } from '@/lib/contracts/agent';
import { decimalText } from '@/lib/decimal';
import { moneyToCents } from '@/lib/money';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string';
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || text(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function money(value: unknown): value is string {
  if (!text(value) || !/^-?\d+\.\d{2}$/.test(value)) return false;
  try { moneyToCents(value); return true; } catch { return false; }
}

function decimal(value: unknown): value is string {
  if (!text(value)) return false;
  try { decimalText(value); return true; } catch { return false; }
}

export function contactPayload(value: unknown): ContactCardView[] | null {
  if (!Array.isArray(value)) return null;
  const contacts: ContactCardView[] = [];
  for (const entry of value) {
    if (!record(entry) || !text(entry.name) || !text(entry.phone) || !optionalText(entry.bank) || !optionalText(entry.remark)) return null;
    contacts.push({ name: entry.name, phone: entry.phone, ...(entry.bank === undefined ? {} : { bank: entry.bank }),
      ...(entry.remark === undefined ? {} : { remark: entry.remark }) });
  }
  return contacts;
}

export function dashboardPayload(value: unknown): DashboardCardView | null {
  if (!record(value) || !decimal(value.totalAssets) || !money(value.checkingBalance) || !money(value.creditAvailable) ||
    !money(value.monthSpend) || !text(value.month) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) || !timestamp(value.asOf)) return null;
  return { totalAssets: value.totalAssets, checkingBalance: value.checkingBalance, creditAvailable: value.creditAvailable,
    monthSpend: value.monthSpend, month: value.month, asOf: value.asOf };
}

export function scheduledPayload(value: unknown): ScheduledCardView[] | null {
  const list = Array.isArray(value) ? value : [value];
  const scheduled: ScheduledCardView[] = [];
  for (const entry of list) {
    if (!record(entry) || !text(entry.name) || !timestamp(entry.runAt) || typeof entry.requiresConfirmation !== 'boolean' ||
      !text(entry.kind) || !['REMINDER', 'PAYMENT', 'TRANSFER'].includes(entry.kind) ||
      !text(entry.status) || !['SCHEDULED', 'DISPATCHING', 'AWAITING_CONFIRMATION', 'DONE', 'FAILED', 'CANCELLED'].includes(entry.status)) return null;
    scheduled.push({ name: entry.name, runAt: entry.runAt, requiresConfirmation: entry.requiresConfirmation,
      kind: entry.kind as ScheduledCardView['kind'], status: entry.status as ScheduledCardView['status'] });
  }
  return scheduled;
}

export function budgetPayload(value: unknown): BusinessReceipt | null {
  if (!record(value) || !text(value.name) || !money(value.amount) || !optionalText(value.purpose) ||
    !text(value.status) || !['RESERVED', 'USED', 'RELEASED'].includes(value.status) || value.dueDate !== undefined && !timestamp(value.dueDate)) return null;
  return { kind: 'budget', name: value.name, amount: value.amount, status: value.status as 'RESERVED' | 'USED' | 'RELEASED',
    ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
    ...(value.dueDate === undefined ? {} : { dueDate: value.dueDate as number }) };
}

export function investmentPayload(value: unknown, kind: 'investmentPurchase' | 'investmentRedemption'): BusinessReceipt | null {
  if (!record(value) || typeof value.success !== 'boolean' || !money(value.amount) || !money(value.newBalance) || !timestamp(value.occurredAt) ||
    value.redemptionValuation !== undefined && !decimal(value.redemptionValuation) ||
    value.settlementRounding !== undefined && value.settlementRounding !== 'HALF_UP' ||
    value.productName !== undefined && !text(value.productName) ||
    ['remainingShares', 'redeemedShares', 'netValuePerUnit'].some(key => value[key] !== undefined && !decimal(value[key])) ||
    value.feeAmount !== undefined && !money(value.feeAmount)) return null;
  return { kind, success: value.success, amount: value.amount, newBalance: value.newBalance, occurredAt: value.occurredAt,
    ...(value.productName === undefined ? {} : { productName: value.productName as string }),
    ...(value.remainingShares === undefined ? {} : { remainingShares: value.remainingShares as string }),
    ...(value.redeemedShares === undefined ? {} : { redeemedShares: value.redeemedShares as string }),
    ...(value.netValuePerUnit === undefined ? {} : { netValuePerUnit: value.netValuePerUnit as string }),
    ...(value.feeAmount === undefined ? {} : { feeAmount: value.feeAmount as string }),
    ...(value.redemptionValuation === undefined ? {} : { redemptionValuation: value.redemptionValuation as string }),
    ...(value.settlementRounding === undefined ? {} : { settlementRounding: 'HALF_UP' as const }) };
}

