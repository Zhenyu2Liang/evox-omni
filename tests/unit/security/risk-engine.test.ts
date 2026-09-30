/**
 * Unit: security/risk-engine — dynamic transfer tier + day-total computation.
 *
 * Targets `@/security/risk-engine`: evaluateTransferRisk({amount, dailyTransferTotal}),
 * computeDailyTransferTotal(userId, now?) (+ types TransferRiskInput, TransferRiskResult).
 *
 * `evaluateTransferRisk` is PURE & deterministic (no DB, no network).
 * `computeDailyTransferTotal` reads the transaction repository → requires test SQLite via ../helpers/db.
 */
import { describe, it } from 'vitest';

// import { evaluateTransferRisk, computeDailyTransferTotal } from '@/security/risk-engine';   // <- uncomment in Phase 2
// import { DAILY_TRANSFER_LIMIT } from '@/lib/constants';

describe('risk-engine · evaluateTransferRisk · boundary (limit ¥1000)', () => {
  it.todo('¥200, no prior transfers → tier YELLOW, requiresConfirmation true, requiresMfa false');
  it.todo('amount exactly ¥1000, dailyTotal 0 → YELLOW (not strictly greater than the limit)');
  it.todo('amount ¥1000.01, dailyTotal 0 → RED, requiresMfa true');
  it.todo('amount ¥500 with dailyTotal 600 (projected ¥1100) → RED (day rule; amount alone is small)');
  it.todo('amount ¥500 with dailyTotal 500 (projected exactly ¥1000) → YELLOW (not strictly greater)');
});

describe('risk-engine · evaluateTransferRisk · result shape', () => {
  it.todo('requiresConfirmation is ALWAYS true for transfers (both YELLOW and RED)');
  it.todo("requiresMfa === (tier === 'RED')");
  it.todo('reports amount, dailyTotal (echoed) and projectedDailyTotal === dailyTotal + amount');
  it.todo('reasons[] is non-empty and explains the deciding rule (amount vs day total)');
  it.todo('is deterministic: identical input yields a deep-equal result');
});

describe('risk-engine · computeDailyTransferTotal (needs test SQLite)', () => {
  it.todo("sums only TODAY's outgoing DEBIT transfers for the given userId");
  it.todo('is deterministic via the injected now: a fixed now selects exactly one calendar day');
  it.todo('excludes transfers from other days (yesterday / tomorrow relative to now)');
  it.todo('excludes incoming CREDIT transactions and non-transfer debits (e.g. card purchases)');
  it.todo('returns 0 when the user has no transfers today');
  it.todo("scopes to the given userId (another user's transfers today are not counted)");
});
