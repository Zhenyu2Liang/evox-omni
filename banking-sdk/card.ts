/**
 * Banking SDK — card reads & mutations.
 * `getCards` is GREEN; the mutations are executed only after the Security Gateway's tier policy
 * (YELLOW/RED) is satisfied — this module performs no permission checks itself.
 *
 * Domain invariants enforced here (never by the model):
 *  - the card must exist → `AppError('NOT_FOUND')`;
 *  - a per-category limit needs a non-empty category and a non-negative amount
 *    → `AppError('VALIDATION')`;
 *  - a `LOST` card can neither be frozen nor unfrozen, and an already-`LOST` card cannot be
 *    reported lost again → `AppError('CONFLICT')`;
 *  - only a currently-`LOST` card may be replaced, and replacement is idempotent: a card that
 *    already points at a replacement returns that card instead of minting a second one
 *    → otherwise `AppError('CONFLICT')`;
 *  - freezing an already-frozen (or unfreezing an already-active) card is idempotent: the current
 *    status is returned without a write.
 *
 * `freezeCard`/`unfreezeCard` are reversible (temporary lock), `reportLostCard` is terminal (the
 * card stays `LOST` and can never be revived), and `replaceCard` links the lost card to a NEW card
 * via `Card.replacedByCardId` (a historical reference, not a relation).
 *
 * `setCardLimit` replaces a card+category limit as a single all-or-nothing unit
 * (`runInTransaction`): the delete and the create commit together, so the card never ends up with
 * zero or duplicate limit rows for that category.
 *
 * `applyVirtualCard` accepts an OPTIONAL `idempotencyKey`: when supplied, the card id is derived
 * deterministically from `(userId, key)` and a repeat replays the existing card instead of issuing a
 * second one (a plan node can be replayed after a resume/retry — see `./idempotent.ts`).
 *
 * DEBIT and VIRTUAL cards are ACCOUNT-BOUND: `applyVirtualCard`/`addDemoCard` bind one of the user's
 * CHECKING accounts (`Card.linkedAccountId`, a real FK), and `consumeCard` is the single SDK capability
 * that spends from a card — it debits that account with an atomic sufficient-funds write and writes a
 * `channel='CARD'` ledger row plus a `CardConsumption` row in ONE transaction, guarded by the card's
 * monthly limit. A binding is resolved EXPLICITLY (`input.linkedAccountId`) or, when the user owns
 * EXACTLY ONE CHECKING account, from that single account; zero or several candidates is a
 * `VALIDATION` error. The SDK never guesses which account a card spends from — only the one-off
 * backfill `scripts/card-account-binding.ts` infers one.
 *
 * THE PROJECTION IS TOTAL AND HONEST. Every `CardView` reports `linkedAccountStatus`
 * (`LINKED`/`MISSING`/`UNTRUSTED`/`NOT_APPLICABLE`) and `usable`, and exposes
 * `linkedAccountNumber`/`linkedAccountName`/`accountAvailableBalance`/`payableAmount` ONLY from a
 * settlement account that resolves to the card's own CHECKING account. A missing or untrusted binding
 * exposes NO balance (never another owner's cash, never a fabricated `0.00`), a CREDIT card has no
 * settlement account at all, and a card that cannot spend (`FROZEN`/`LOST`/`PENDING`) still reports
 * its balances: unusable is not the same as empty.
 *
 * CONSUMPTION TIME IS SERVER-OWNED. `consumeCard` stamps the booking instant from the project
 * business clock (`demoNow()`, UTC+08:00 semantics) and derives the monthly-limit window from that
 * same instant, so a caller cannot back-date a spend out of the current billing month and the card
 * projection `consumeCard` returns reports the month it enforced. The public parameter set
 * (`ConsumeCardInput`) therefore has no `occurredAt`; a runtime object that still carries a DEFINED
 * `occurredAt` is rejected with `AppError('VALIDATION')` before any write. The only way to pin the
 * clock is the separate, test-only `ConsumeCardOptions` second argument.
 *
 * MONTHLY SPEND IS FAMILY-CONTINUOUS. `Card.replacedByCardId` records a 补办 as a NEW card row and
 * the spend history is never rewritten, so the current month's spend of a replaced card belongs to
 * the whole replacement family (see `./card-family`). Both the enforced limit in `consumeCard` and
 * the derived `payableAmount` of the projection read that ONE family number at ONE instant, so the
 * allowance the user sees and the allowance the SDK enforces cannot diverge. A VIRTUAL or DEBIT
 * replacement inherits and RE-VALIDATES its predecessor's settlement account (a broken binding is
 * restored only from that explicit source link, never from a guessed default account).
 */
import type {
  Account as AccountRow,
  Card as CardRow,
  CardConsumption as CardConsumptionRow,
  CardLimit as CardLimitRow,
} from '@/lib/db/prisma';
import { cards } from '../lib/db/repositories';
import { dbClient } from '../lib/db/client';import { AppError } from '../lib/errors';
import { centsToMoney, moneyToCents } from '../lib/money';
import { maskCardNumber } from '../lib/mask';
import { demoNow } from '../lib/clock';
import { idempotentCardId, isUniqueViolation, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction, type Tx } from './tx';
import type { AddDemoCardRequest } from '../lib/contracts/card-management';
import { safeParse, toJson } from '../lib/json';
import { SPENDING_CATEGORIES } from './categories';
import { cardFamilyMonthSpend } from './card-family';
import type {
  ApplyVirtualCardInput,
  CardConsumptionQuery,
  CardConsumptionView,
  CardStatus,
  CardType,
  CardView,
  ConsumeCardInput,
  ConsumeCardOptions,
  ConsumeCardResult,
  ReportLostCardInput,
  SetCardLimitInput,
} from './types';

/** Network of a newly issued virtual card (demo sandbox). */
const VIRTUAL_CARD_NETWORK = 'UnionPay';

/**
 * The FICTIONAL complete number every card this module MINTS also carries.
 *
 * A card row keeps two columns: `numberMasked` (the display value every projection emits) and the
 * SERVER-ONLY `numberFull`, which lets `security/card-resolution.ts` match a user-typed COMPLETE card
 * number by exact equality. The issued number is deliberately fictitious — `6222` followed by an
 * all-`0000` middle block and the card's own unique four-digit tail (`6222 0000 0000 1234`) — so no
 * real bank card number is ever minted or stored here. It is written ONLY for a NEW row (an existing
 * row is never rewritten) and is NEVER projected, summarized or logged: `toCardView` reads
 * `numberMasked` alone.
 */
const FICTIONAL_CARD_BIN = '6222';
const FICTIONAL_CARD_NUMBER_LENGTH = 16;
/**
 * How many trailing digits of the complete number the display value is derived from. Card masks are
 * eight characters wide (`****1234`) — the shape of every seeded row and of the transport contract —
 * while `maskCardNumber` keeps its input's length, so the derived tail window matches that width.
 */
const CARD_MASK_SOURCE_LENGTH = 8;

/** Merchant label used when a card consumption omits one (local simulation only). */
const DEFAULT_CONSUME_MERCHANT = '本地模拟消费';

/** Page size for card-consumption reads when no limit is supplied. */
const DEFAULT_CONSUMPTION_LIMIT = 20;
/** Hard cap on card-consumption reads. */
const MAX_CONSUMPTION_LIMIT = 200;

/**
 * How a card's settlement account resolved for ONE projection, mirroring
 * `CardView.linkedAccountStatus`. Only `LINKED` carries an account, and therefore only `LINKED` may
 * expose a balance: the projection of a `MISSING`/`UNTRUSTED` card has no balance field at all.
 */
type SettlementResolution =
  | { status: 'LINKED'; account: AccountRow }
  | { status: 'MISSING' }
  | { status: 'UNTRUSTED' }
  | { status: 'NOT_APPLICABLE' };

/**
 * Resolve the settlement account a card projection may report, in ONE read of the SAME client (and
 * therefore of the SAME open transaction, see `dbClient()`).
 *
 * Existence, ownership AND the CHECKING type are checked in a single `where`, so an account that
 * was deleted, belongs to another user or is a `SAVINGS` account resolves to `UNTRUSTED` instead of
 * leaking its number/balance into the card. The status is total: a CREDIT card is never looked up
 * (`NOT_APPLICABLE`, it draws on its credit line), a `null` binding is `MISSING`, and NOTHING here
 * ever falls back to "the user's default account" — an implicit account is never inferred.
 */
async function resolveSettlement(row: CardRow): Promise<SettlementResolution> {
  if ((row.type as CardType) === 'CREDIT') return { status: 'NOT_APPLICABLE' };
  if (row.linkedAccountId === null) return { status: 'MISSING' };
  const account = await dbClient().account.findFirst({
    where: { id: row.linkedAccountId, userId: row.userId, type: 'CHECKING' },
  });
  return account === null ? { status: 'UNTRUSTED' } : { status: 'LINKED', account };
}

/**
 * Map a Prisma card row + its category limits onto the frozen `CardView` DTO.
 *
 * `spentMinor` is the card FAMILY's spend in the projected business month. It is ONLY consulted when
 * the card carries a monthly limit (a `null` limit is governance-free, so the account balance alone
 * caps `payableAmount`) and is ignored entirely unless the binding resolved to `LINKED`.
 *
 * The balance block is written ONLY for a resolved, owned, CHECKING settlement account: a card never
 * gets a copy of its own balance, a `MISSING`/`UNTRUSTED` binding emits no balance field (never zero,
 * never somebody else's cash), and `usable` is derived from the status alone, so a frozen/lost card
 * still shows its balances.
 */
function toCardView(
  row: CardRow,
  limits: CardLimitRow[],
  settlement: SettlementResolution,
  spentMinor: bigint,
): CardView {
  const status = row.status as CardStatus;
  const view: CardView = {
    id: row.id,
    type: row.type as CardType,
    network: row.network,
    numberMasked: row.numberMasked,
    status,
    creditLimit: row.creditLimitMinor === null ? undefined : centsToMoney(row.creditLimitMinor),
    availableLimit: row.availableLimitMinor === null ? undefined : centsToMoney(row.availableLimitMinor),
    monthlyLimit: row.monthlyLimitMinor === null ? undefined : centsToMoney(row.monthlyLimitMinor),
    replacedByCardId: row.replacedByCardId ?? undefined,
    linkedAccountId: row.linkedAccountId ?? undefined,
    linkedAccountStatus: settlement.status,
    usable: status === 'ACTIVE',
    limits: limits.map((limit) => ({ category: limit.category, amount: centsToMoney(limit.amountMinor) })),
  };
  if (settlement.status !== 'LINKED') return view;

  const availableMinor = settlement.account.balanceMinor;
  // Remaining monthly allowance; a null monthly limit means unlimited (balance-governed only).
  const remaining = row.monthlyLimitMinor === null
    ? undefined
    : (row.monthlyLimitMinor > spentMinor ? row.monthlyLimitMinor - spentMinor : 0n);
  const payableMinor = remaining === undefined
    ? availableMinor
    : (availableMinor < remaining ? availableMinor : remaining);

  view.linkedAccountNumber = settlement.account.number;
  view.linkedAccountName = settlement.account.name;
  view.accountAvailableBalance = centsToMoney(availableMinor);
  view.payableAmount = centsToMoney(payableMinor);
  return view;
}

/**
 * Sum of `cardId`'s spend in the business month of `now` (`demoNow()` when omitted), attributed to
 * its whole replacement FAMILY (exact CNY minor units). Delegates to `./card-family` so the enforced
 * limit and `payableAmount` are one number read at one instant, inside `dbClient()`'s transaction.
 */
async function spentThisMonthMinor(cardId: string, userId: string, now?: number | Date): Promise<bigint> {
  return cardFamilyMonthSpend(dbClient(), cardId, userId, now);
}

/**
 * Map a card row onto a `CardView`, loading its per-category limits and — for a card whose settlement
 * binding RESOLVES — the linked account's masked number, name, balance and `payableAmount` for the
 * business month of `now` (`demoNow()` when omitted; `consumeCard` passes the instant it enforced
 * with). The spend behind it is the FAMILY's, so a 补办 card immediately shows the remaining allowance
 * of its predecessor, and it is only read when a monthly limit actually needs it.
 */
async function loadCardView(row: CardRow, now?: number | Date): Promise<CardView> {
  const limits = await cards.listCardLimits(row.id);
  const settlement = await resolveSettlement(row);
  if (settlement.status !== 'LINKED') return toCardView(row, limits, settlement, 0n);
  // Without a monthly limit `payableAmount` is the account balance, so the family spend is not read.
  const spentMinor = row.monthlyLimitMinor === null ? 0n : await spentThisMonthMinor(row.id, row.userId, now);
  return toCardView(row, limits, settlement, spentMinor);
}

/** Map a persisted consumption row onto the frozen `CardConsumptionView` DTO. */
function toConsumptionView(row: CardConsumptionRow): CardConsumptionView {
  return {
    id: row.id,
    cardId: row.cardId,
    accountId: row.accountId,
    amount: centsToMoney(row.amountMinor),
    currency: row.currency,
    category: row.category,
    merchant: row.merchant,
    occurredAt: row.occurredAt.getTime(),
    executionKey: row.executionKey ?? undefined,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Resolve the settlement account a NEW DEBIT/VIRTUAL card must be bound to.
 *
 * The binding is resolved EXPLICITLY, never guessed:
 *  - an explicit `requestedId` must name one of the user's CHECKING accounts (a missing/foreign id
 *    is `SECURITY_DENIED`, a non-CHECKING account is `VALIDATION`);
 *  - when it is omitted, the user's CHECKING account is used ONLY if the user owns EXACTLY ONE —
 *    zero candidates or several candidates are a `VALIDATION` error asking for an explicit choice.
 *
 * There is deliberately NO "first account by id" fallback: which account a card spends from decides
 * whose cash moves, so an implicit pick would silently charge an account the user never chose. An
 * implicit resolution exists ONLY in the one-off backfill `scripts/card-account-binding.ts`; the SDK
 * never infers it.
 */
async function resolveLinkedAccount(tx: Tx, userId: string, requestedId?: string): Promise<AccountRow> {
  const requested = typeof requestedId === 'string' ? requestedId.trim() : '';
  if (requested !== '') {
    const account = await tx.account.findUnique({ where: { id: requested } });
    if (!account || account.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '绑定的结算账户不存在或不属于该用户。', { linkedAccountId: requestedId });
    }
    if (account.type !== 'CHECKING') {
      throw new AppError('VALIDATION', '借记卡与虚拟卡只能绑定活期账户。', { linkedAccountId: account.id, type: account.type });
    }
    return account;
  }
  // `take: 2` is enough to tell "exactly one" from "several" without reading every account.
  const candidates = await tx.account.findMany({
    where: { userId, type: 'CHECKING' },
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (candidates.length === 1) return candidates[0];
  throw new AppError('VALIDATION', candidates.length === 0
    ? '该用户没有可用于绑定结算账户的活期账户，请显式指定 linkedAccountId。'
    : '该用户有多个活期账户，请显式指定 linkedAccountId 作为结算账户。', {
    userId,
    candidates: candidates.length,
  });
}

/**
 * Re-validate a RECORDED settlement binding inside the current transaction: the account row must
 * exist, belong to `userId` and be a CHECKING account. `Card.linkedAccountId` is a historical
 * reference, so the account can drift out from under it — any drift is an explicit `CONFLICT`
 * (`UNTRUSTED` in the projection's vocabulary) and is NEVER repaired by guessing another account.
 */
async function requireSettlementAccount(
  tx: Tx,
  userId: string,
  cardId: string,
  linkedAccountId: string,
): Promise<AccountRow> {
  const account = await tx.account.findFirst({ where: { id: linkedAccountId, userId } });
  if (!account) {
    throw new AppError('CONFLICT', '卡片绑定的结算账户不存在或不属于该用户（UNTRUSTED）。', {
      cardId,
      linkedAccountId,
      linkedAccountStatus: 'UNTRUSTED',
    });
  }
  if (account.type !== 'CHECKING') {
    throw new AppError('CONFLICT', '卡片绑定的账户不是活期账户（UNTRUSTED）。', {
      cardId,
      accountId: account.id,
      type: account.type,
      linkedAccountStatus: 'UNTRUSTED',
    });
  }
  return account;
}

/**
 * Settlement account `card` must spend from, repaired when its binding is MISSING.
 * A recorded binding is re-validated by `requireSettlementAccount`. A `null` binding — a
 * replacement card minted before the binding was inherited — is restored from the card's EXPLICIT
 * predecessor (the row whose `replacedByCardId` is this card) and persisted, but only when that
 * source records a valid, owned, CHECKING account. When there is no such explicit source link the
 * function returns `null` and the caller rejects: no "user's default account" and no free-text
 * inference, ever.
 */
async function resolveSettlementAccount(tx: Tx, card: CardRow): Promise<AccountRow | null> {
  if (card.linkedAccountId !== null) {
    return requireSettlementAccount(tx, card.userId, card.id, card.linkedAccountId);
  }
  const predecessor = await tx.card.findFirst({
    where: { userId: card.userId, replacedByCardId: card.id, linkedAccountId: { not: null } },
    orderBy: { id: 'asc' },
    select: { linkedAccountId: true },
  });
  const inherited = predecessor?.linkedAccountId ?? null;
  if (inherited === null) return null;

  const account = await requireSettlementAccount(tx, card.userId, card.id, inherited);
  const repaired = await tx.card.updateMany({
    where: { id: card.id, userId: card.userId, linkedAccountId: null },
    data: { linkedAccountId: account.id },
  });
  if (repaired.count === 0) {
    // Another writer bound the card first: accept it ONLY when it resolves to the same account.
    const current = await tx.card.findFirst({ where: { id: card.id, userId: card.userId }, select: { linkedAccountId: true } });
    if (current?.linkedAccountId !== account.id) {
      throw new AppError('CONFLICT', '卡片结算账户在恢复过程中被其他写入改变。', { cardId: card.id });
    }
  }
  return account;
}

/** Resolve a card or throw `AppError('NOT_FOUND')`. */
async function requireCard(cardId: string, userId: string): Promise<CardRow> {
  if (typeof userId !== 'string' || !userId.trim()) throw new AppError('SECURITY_DENIED', '缺少卡片操作用户身份。');
  const row = typeof cardId === 'string' && cardId.length > 0 ? await cards.getCard(cardId) : null;
  if (!row) throw new AppError('NOT_FOUND', `卡片不存在：${String(cardId)}`, { cardId });
  if (row.userId !== userId) throw new AppError('SECURITY_DENIED', '无权操作该卡片。');
  return row;
}

/**
 * Move a card to `next`, allowing the transition only from `allowedFrom`.
 * A card already in `next` is returned untouched (idempotent, no write); any other status is an
 * illegal transition → `AppError('CONFLICT')`.
 */
async function transitionTo(
  row: CardRow,
  next: CardStatus,
  allowedFrom: readonly CardStatus[],
): Promise<CardRow> {
  return runInTransaction(async tx => {
    const latest = await tx.card.findUnique({ where: { id: row.id, userId: row.userId } });
    if (!latest) throw new AppError('NOT_FOUND', 'Card does not exist.');
    const current = latest.status as CardStatus;
    if (current === next) return latest;
    if (!allowedFrom.includes(current)) {
      throw new AppError('CONFLICT', 'The card state does not allow this transition.', { cardId: row.id, from: current, to: next });
    }
    const updated = await tx.card.updateMany({ where: { id: row.id, userId: row.userId, status: current }, data: { status: next } });
    const committed = await tx.card.findUnique({ where: { id: row.id, userId: row.userId } });
    if (!committed) throw new AppError('NOT_FOUND', 'Card does not exist.');
    if (updated.count === 0 && committed.status !== next) {
      throw new AppError('CONFLICT', 'The card state changed before the operation committed.', { cardId: row.id, status: committed.status });
    }
    return committed;
  });
}

/** All cards owned by the user (with per-category limits). */
export async function getCards(userId: string): Promise<CardView[]> {
  return runInTransaction(async () => {
    const rows = await cards.listCards(userId);
    // Wrapped (not `rows.map(loadCardView)`) so `map`'s index cannot leak into the `now` seam.
    return Promise.all(rows.map((row) => loadCardView(row)));
  });
}

/**
 * Create a simulated record only; the dedicated manual command owns MFA, audit and replay.
 *
 * A DEBIT or VIRTUAL card is ACCOUNT-BOUND at creation: it spends from one of the owner's CHECKING
 * accounts (`input.linkedAccountId`, validated for ownership + type, or the single CHECKING account
 * when the user owns exactly one — see `resolveLinkedAccount`). A CREDIT card is never bound: it
 * draws on its credit line.
 */
export async function addDemoCard(userId: string, input: Omit<AddDemoCardRequest, 'requestId'>): Promise<CardView> {
  if (!['DEBIT', 'CREDIT', 'VIRTUAL'].includes(input.type)) throw new AppError('VALIDATION', 'Invalid card type.');
  const creditLimitMinor = input.creditLimit === undefined ? null : moneyToCents(input.creditLimit);
  const monthlyLimitMinor = input.monthlyLimit === undefined ? null : moneyToCents(input.monthlyLimit);
  if (input.type === 'CREDIT' && (creditLimitMinor === null || creditLimitMinor <= 0n)) throw new AppError('VALIDATION', 'A credit card requires a positive credit limit.');
  if (input.type !== 'CREDIT' && creditLimitMinor !== null) throw new AppError('VALIDATION', 'Only credit cards accept a credit limit.');
  if (monthlyLimitMinor !== null && monthlyLimitMinor < 0n) throw new AppError('VALIDATION', 'Monthly limit must be non-negative.');
  return runInTransaction(async tx => {
    // DEBIT and VIRTUAL cards both spend from a settlement CHECKING account; CREDIT cards never do.
    const linkedAccountId = input.type === 'CREDIT'
      ? null
      : (await resolveLinkedAccount(tx, userId, input.linkedAccountId)).id;
    const own = await tx.card.findMany({ where: { userId } });
    // NEW row only: the fictional complete number and the mask derived from it.
    const { numberFull, numberMasked } = generateCardIdentity(own);
    const row = await tx.card.create({ data: { userId, type: input.type, network: 'UnionPay',
      numberMasked, numberFull, status: 'ACTIVE',
      creditLimitMinor, availableLimitMinor: creditLimitMinor, monthlyLimitMinor, linkedAccountId } });
    return loadCardView(row);
  });
}

/** Read-only eligibility check, repeated inside the serialized deletion transaction. */
export async function assertDemoCardDeletable(userId: string, cardId: string, ownActionId: string): Promise<CardView> {
  return runInTransaction(async tx => {
    const row = await requireCard(cardId, userId);
    if (row.type === 'CREDIT' && (row.creditLimitMinor === null || row.availableLimitMinor === null || row.creditLimitMinor !== row.availableLimitMinor)) {
      throw new AppError('CONFLICT', 'A card with outstanding or unknown credit obligations cannot be deleted.');
    }
    const referencesCard = (json: string | null): boolean => {
      const visit = (value: unknown): boolean => {
        if (typeof value === 'string') return value === cardId || value === row.numberMasked || value === row.numberMasked.slice(-4);
        if (Array.isArray(value)) return value.some(visit);
        if (value && typeof value === 'object') return Object.values(value).some(visit);
        return false;
      };
      return visit(safeParse(json ?? '', null));
    };
    const actions = await tx.pendingAction.findMany({ where: { userId, id: { not: ownActionId },
      status: { in: ['pending', 'awaiting_mfa', 'confirmed', 'locked', 'needs_reconciliation'] } } });
    const invocations = await tx.toolInvocation.findMany({ where: { run: { userId },
      status: { in: ['started', 'waiting_confirmation', 'waiting_verification', 'interrupted', 'needs_reconciliation'] } } });
    const nodes = await tx.agentTaskNode.findMany({ where: { task: { userId, status: { notIn: ['completed', 'cancelled'] } },
      status: { notIn: ['success', 'completed', 'cancelled', 'skipped'] } } });
    const generating = await tx.agentRun.count({ where: { userId, status: { in: ['running', 'interrupted'] } } });
    const runningPlans = await tx.agentTask.count({ where: { userId, status: { in: ['running', 'pending'] } } });
    if (generating > 0 || runningPlans > 0 || actions.some(action => action.status === 'needs_reconciliation' || referencesCard(action.argsJson)) ||
        invocations.some(invocation => invocation.status === 'needs_reconciliation' || referencesCard(invocation.argsJson)) ||
        nodes.some(node => referencesCard(node.args))) {
      throw new AppError('CONFLICT', 'Resolve pending or uncertain operations involving this card before deleting it.');
    }
    return loadCardView(row);
  });
}

/** Delete a simulated card while preserving the ledger, immutable receipts and audit history. */
export async function deleteDemoCard(userId: string, cardId: string, ownActionId: string): Promise<CardView> {
  return runInTransaction(async tx => {
    const view = await assertDemoCardDeletable(userId, cardId, ownActionId);
    await tx.cardLimit.deleteMany({ where: { cardId } });
    await tx.card.delete({ where: { id: cardId, userId } });
    return view;
  });
}

/** Set/replace the per-category spend limit on a card; returns the updated card. */
export async function setCardLimit(input: SetCardLimitInput): Promise<CardView> {
  const row = await requireCard(input?.cardId, input?.userId);

  const category = typeof input?.category === 'string' ? input.category.trim() : '';
  if (category === '') {
    throw new AppError('VALIDATION', '缺少限额分类', { cardId: row.id, category: input?.category });
  }
  if (!(SPENDING_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError('VALIDATION', 'Card limit category must be a supported spending category.');
  }
  const amountMinor = moneyToCents(input?.amount);
  if (amountMinor < 0n) {
    throw new AppError('VALIDATION', '限额必须是不小于 0 的金额', {
      cardId: row.id,
      category,
      amount: input?.amount,
    });
  }

  // Replace semantics: a card+category keeps exactly ONE limit row. The delete and the create run
  // in ONE transaction, so a failure can never leave the category without its limit.
  return runInTransaction(async (tx) => {
    const current = await tx.card.findUnique({ where: { id: row.id, userId: input.userId } });
    if (!current) throw new AppError('NOT_FOUND', 'Card does not exist.');
    if (current.status !== 'ACTIVE' && current.status !== 'FROZEN') {
      throw new AppError('CONFLICT', 'Only active or frozen cards support category limit changes.', { cardId: row.id, status: current.status });
    }
    await tx.cardLimit.deleteMany({ where: { card: { id: row.id, userId: input.userId }, category } });
    await tx.cardLimit.create({ data: { card: { connect: { id: row.id, userId: input.userId } }, category, amountMinor } });
    return loadCardView(current);
  });
}

/** Freeze a card (status → FROZEN); returns the updated card. */
export async function freezeCard(cardId: string, userId: string): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  const updated = await transitionTo(row, 'FROZEN', ['ACTIVE', 'PENDING']);
  return loadCardView(updated);
}

/** Unfreeze a card (status → ACTIVE); returns the updated card. */
export async function unfreezeCard(cardId: string, userId: string): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  // Only a FROZEN card can be unfrozen; an ACTIVE one is a no-op, a LOST one may not be revived.
  const updated = await transitionTo(row, 'ACTIVE', ['FROZEN']);
  return loadCardView(updated);
}

/**
 * Report a card lost (status → LOST); returns the updated card.
 * The calling layer records the optional reason in the audit trail.
 */
export async function reportLostCard(
  cardId: string,
  userId: string,
  input: ReportLostCardInput = {},
): Promise<CardView> {
  const row = await requireCard(cardId, userId);
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw new AppError('VALIDATION', 'Loss reporting reason must be text.');
  }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() || undefined : undefined;
  if ((row.status as CardStatus) === 'LOST') {
    throw new AppError('CONFLICT', '该卡片已挂失，无需重复挂失', {
      cardId: row.id,
      status: row.status,
      reason,
    });
  }
  const updated = await runInTransaction(async tx => {
    const result = await tx.card.updateMany({ where: { id: row.id, userId, status: row.status }, data: { status: 'LOST' } });
    if (result.count !== 1) throw new AppError('CONFLICT', 'The card state changed before loss reporting committed.');
    return tx.card.findUniqueOrThrow({ where: { id: row.id, userId } });
  });
  return loadCardView(updated);
}

/**
 * Replace a `LOST` card with a NEW card (same owner, same `type` and `network`).
 * The replacement is a fresh row with a new masked number (and the accompanying FICTIONAL complete
 * number, `numberFull`). It carries the source's monthly limit,
 * and a CREDIT replacement also inherits the source's approved credit limit and current available limit
 * (per-category limits are NOT copied). The source stays `LOST` and records the new card id in
 * `replacedByCardId` — a historical reference, not a status change and not a relation.
 *
 * A DEBIT or VIRTUAL replacement also inherits the source's settlement account, RE-VALIDATED in the
 * same transaction (the row must exist, belong to `userId` and be `CHECKING`), so the replacement can
 * spend immediately and from the same cash. A VIRTUAL source without a usable binding is a
 * `CONFLICT` — a virtual card that cannot spend is never minted. An UNBOUND DEBIT source is only
 * `MISSING`, not fatal: its replacement is issued and stays unbound. The monthly limit keeps running
 * across the replacement: the current-month spend is the FAMILY's (see `./card-family`), so the new
 * card inherits the remaining allowance, while the already-booked `CardConsumption` rows stay
 * attributed to the card that incurred them.
 *
 * Idempotent: inside ONE transaction a source that already points at a replacement returns that
 * existing card instead of issuing a second one (a plan node may be replayed after a resume). An
 * existing DEBIT/VIRTUAL replacement whose binding is missing is repaired from this same explicit
 * source link.
 */
export async function replaceCard(cardId: string, userId: string): Promise<CardView> {
  const source = await requireCard(cardId, userId);
  if ((source.status as CardStatus) !== 'LOST') {
    throw new AppError('CONFLICT', '只有已挂失的卡片可以补办，请先办理挂失。', { cardId: source.id, status: source.status });
  }
  return runInTransaction(async tx => {
    const latest = await tx.card.findUnique({ where: { id: source.id, userId } });
    if (!latest) throw new AppError('NOT_FOUND', 'Card does not exist.');
    if ((latest.status as CardStatus) !== 'LOST') {
      throw new AppError('CONFLICT', '只有已挂失的卡片可以补办，请先办理挂失。', { cardId: latest.id, status: latest.status });
    }
    // A DEBIT or VIRTUAL card spends from its settlement account, so the binding must survive the
    // 补办. A recorded binding is RE-VALIDATED here (owned + CHECKING) and a drifted one is a
    // CONFLICT; a VIRTUAL card without any binding is also fatal, because a virtual card that cannot
    // spend is never minted. An UNBOUND DEBIT card, by contrast, is merely `MISSING`: the 补办 goes
    // ahead and the replacement stays unbound instead of blocking the user out of a new card.
    let settlementAccountId: string | null = null;
    if (latest.type === 'VIRTUAL' || latest.type === 'DEBIT') {
      if (latest.linkedAccountId === null) {
        if (latest.type === 'VIRTUAL') {
          throw new AppError('CONFLICT', '原虚拟卡未绑定结算账户，无法补办。', { cardId: latest.id });
        }
      } else {
        settlementAccountId = (await requireSettlementAccount(tx, userId, latest.id, latest.linkedAccountId)).id;
      }
    }
    if (latest.replacedByCardId) {
      const existing = await tx.card.findUnique({ where: { id: latest.replacedByCardId, userId } });
      if (!existing) {
        throw new AppError('CONFLICT', '补卡记录不一致：原卡片关联的补办卡不存在。', {
          cardId: latest.id,
          replacedByCardId: latest.replacedByCardId,
        });
      }
      // A replacement minted before bindings were inherited: repair it from THIS explicit source
      // link (never from a guess), so a replay returns a card that can actually spend.
      if (settlementAccountId !== null && existing.type !== 'CREDIT' && existing.linkedAccountId === null) {
        await tx.card.update({ where: { id: existing.id }, data: { linkedAccountId: settlementAccountId } });
      }
      return loadCardView(await tx.card.findUniqueOrThrow({ where: { id: existing.id, userId } }));
    }
    const own = await tx.card.findMany({ where: { userId } });
    // NEW row only: the fictional complete number and the mask derived from it.
    const { numberFull, numberMasked } = generateCardIdentity(own);
    const created = await tx.card.create({ data: {
      userId,
      type: latest.type,
      network: latest.network,
      numberMasked,
      numberFull,
      status: 'ACTIVE',
      // A replacement CREDIT card inherits the SAME approved credit limit and current available
      // limit (no re-approval); non-credit cards keep none.
      creditLimitMinor: latest.type === 'CREDIT' ? latest.creditLimitMinor : null,
      availableLimitMinor: latest.type === 'CREDIT' ? latest.availableLimitMinor : null,
      monthlyLimitMinor: latest.monthlyLimitMinor,
      // A DEBIT/VIRTUAL replacement keeps spending from the SAME settlement account; CREDIT (and an
      // unbound DEBIT source, which stays `MISSING`) keeps none.
      linkedAccountId: settlementAccountId,
    } });
    await tx.card.update({ where: { id: latest.id, userId }, data: { replacedByCardId: created.id } });
    return loadCardView(created);
  });
}

/**
 * Issue a new virtual card bound to a settlement CHECKING account; returns the created card.
 * The masked number is generated as `****` + 4 digits, avoiding the user's existing masks, and is
 * derived from the same FICTIONAL complete number the row records in `numberFull` (see
 * `generateCardIdentity`); the masked value alone is ever projected.
 * `monthlyLimit` is an explicit cent-valid configuration saved at creation.
 *
 * The settlement account is `input.linkedAccountId` (validated for ownership + CHECKING type) or,
 * when omitted, the user's ONLY CHECKING account — zero or several candidates is a `VALIDATION`
 * error. It is never inferred from a free-text label. *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, the card id is derived
 * deterministically from `(userId, key)` and reused as the primary key, so a repeat of the SAME key
 * finds and REPLAYS the original card (same `id`) instead of issuing a SECOND virtual card. A replay
 * is allowed ONLY when the requested monthly limit AND settlement account match the original card;
 * otherwise it is an explicit `CONFLICT`. Concurrent same-key calls are safe too — the loser's insert
 * violates the PK, its transaction rolls back (no card written), then the winner's committed card is
 * replayed. Absent → unchanged behavior.
 */
export async function applyVirtualCard(input: ApplyVirtualCardInput): Promise<CardView> {
  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') {
    throw new AppError('VALIDATION', '缺少用户 id', { userId: input?.userId });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const cents = input.monthlyLimit === undefined ? undefined : moneyToCents(input.monthlyLimit);
  if (cents !== undefined && cents < 0n) throw new AppError('VALIDATION', 'Monthly limit must be non-negative.');
  const monthlyLimitMinor = cents;
  const replay = (card: CardRow, requestedLinkedAccountId: string): CardRow => {
    if (card.userId !== userId || card.type !== 'VIRTUAL') {
      throw new AppError('CONFLICT', 'The execution identity does not belong to this virtual card issuance.');
    }
    if (card.monthlyLimitMinor !== (monthlyLimitMinor ?? null)) {
      throw new AppError('CONFLICT', '同一幂等身份不能申请不同月限额的虚拟卡。');
    }
    if (card.linkedAccountId !== requestedLinkedAccountId) {
      throw new AppError('CONFLICT', '同一幂等身份不能绑定不同的结算账户。', { linkedAccountId: requestedLinkedAccountId });
    }
    return card;
  };
  if (key === undefined) {
    const row = await runInTransaction(async (tx) => {
      const account = await resolveLinkedAccount(tx, userId, input.linkedAccountId);
      const own = await tx.card.findMany({ where: { userId } });
      // NEW row only: the fictional complete number and the mask derived from it.
      const { numberFull, numberMasked } = generateCardIdentity(own);
      return tx.card.create({ data: {
        userId,
        type: 'VIRTUAL',
        network: VIRTUAL_CARD_NETWORK,
        numberMasked,
        numberFull,
        status: 'ACTIVE',
        monthlyLimitMinor,
        linkedAccountId: account.id,
      } });
    });

    // A brand-new card carries no per-category limits.
    return loadCardView(row);
  }

  // Deterministic-id replay (the `Card` table has no idempotencyKey column): the create goes
  // through `runInTransaction` so the derive-find-create sequence is all-or-nothing, mirroring
  // `setCardLimit`'s in-transaction use of `tx.card*`.
  const cardId = idempotentCardId(userId, key);
  let requestedLinkedAccountId: string | undefined;
  let row: CardRow;
  try {
    row = await runInTransaction(async (tx): Promise<CardRow> => {
      // Resolve the requested settlement account FIRST so a replay can prove the SAME binding.
      const account = await resolveLinkedAccount(tx, userId, input.linkedAccountId);
      requestedLinkedAccountId = account.id;

      const replayed = await tx.card.findUnique({ where: { id: cardId } });
      if (replayed) return replay(replayed, account.id);

      const own = await tx.card.findMany({ where: { userId } });
      // NEW row only: the fictional complete number and the mask derived from it.
      const { numberFull, numberMasked } = generateCardIdentity(own);

      return tx.card.create({
        data: {
          id: cardId,
          userId,
          type: 'VIRTUAL',
          network: VIRTUAL_CARD_NETWORK,
          numberMasked,
          numberFull,
          status: 'ACTIVE',
          monthlyLimitMinor,
          linkedAccountId: account.id,
        },
      });
    });
  } catch (error) {
    // Concurrent same-key race: the other call committed the card first → our tx rolled back (no
    // card written). Re-read the committed card and replay it (proving the same binding).
    if (isUniqueViolation(error) && requestedLinkedAccountId !== undefined) {
      const committed = await cards.getCard(cardId);
      if (committed) return loadCardView(replay(committed, requestedLinkedAccountId));
    }
    throw error;
  }

  return loadCardView(row);
}

/**
 * Resolve the business instant ONE consumption is booked at, and therefore the UTC+08:00 billing
 * month its amount is counted against and that its returned projection reports. Production uses the
 * project demo clock; the seam is validated so a deterministic test can pin the instant, nothing else.
 */
function consumeInstant(now?: number | Date): number {
  if (now === undefined) return demoNow();
  const at = demoNow(now);
  if (typeof at !== 'number' || !Number.isInteger(at)) {
    throw new AppError('VALIDATION', '测试时钟必须是整数毫秒时间戳或 Date。', { now: String(now) });
  }
  return at;
}

/**
 * Spend from an owned, account-bound card.
 *
 * CONSUMPTION TIME IS SERVER-OWNED. The booking instant comes from the project business clock
 * (`demoNow()`), and the monthly-limit window is derived from that SAME instant (`demoMonthRange`),
 * so both the ledger row and the month it is attributed to are server decisions. `ConsumeCardInput`
 * has no `occurredAt`; a runtime input object that still carries a DEFINED `occurredAt` (from a
 * stale client, an HTTP body or a tool-argument object) is rejected with `VALIDATION` BEFORE any
 * write — silently ignoring it would let a caller believe a spend was back-dated. The only clock
 * override is the internal `options.now` seam, which no public caller passes.
 *
 * Inside ONE transaction: replay the persisted consumption when the execution identity matches; else
 * re-validate the card (owned, `ACTIVE`) and its settlement account (owned, `CHECKING`, recovered
 * from the explicit 补办 link when the binding is missing), enforce the card FAMILY's monthly limit,
 * debit the account with an atomic sufficient-funds write, write a `channel='CARD'` ledger row and a
 * `CardConsumption` row, and persist the original result snapshot for same-key replay. Its `card`
 * projection reads that same instant, so it reports the enforced month; amounts stay exact minor units.
 */
export async function consumeCard(
  input: ConsumeCardInput,
  options: ConsumeCardOptions = {},
): Promise<ConsumeCardResult> {
  // Defence in depth, BEFORE any read or write: a caller-owned instant is not merely ignored.
  const rawInput: unknown = input;
  if (typeof rawInput === 'object' && rawInput !== null && 'occurredAt' in rawInput) {
    const claimed = (rawInput as { occurredAt?: unknown }).occurredAt;
    if (claimed !== undefined) {
      throw new AppError('VALIDATION', '消费时间由服务端决定，不接受调用方传入的 occurredAt。', { occurredAt: String(claimed) });
    }
  }

  const userId = typeof input?.userId === 'string' ? input.userId : '';
  if (userId === '') throw new AppError('VALIDATION', '缺少用户 id', { userId: input?.userId });

  const cardId = typeof input?.cardId === 'string' ? input.cardId : '';
  if (cardId === '') throw new AppError('VALIDATION', '缺少卡片 id', { cardId: input?.cardId });

  const amountMinor = moneyToCents(input?.amount);
  if (amountMinor <= 0n) throw new AppError('VALIDATION', '消费金额必须大于零', { amount: input?.amount });

  const category = typeof input?.category === 'string' && input.category.trim() !== ''
    ? input.category.trim()
    : '其他';
  if (!(SPENDING_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError('VALIDATION', '卡消费类别必须受支持。', { category: input?.category });
  }

  const merchant = typeof input?.merchant === 'string' && input.merchant.trim() !== ''
    ? input.merchant.trim()
    : DEFAULT_CONSUME_MERCHANT;

  // ONE server-owned instant for the booking time, the billing month and the returned projection.
  const at = consumeInstant(options.now);

  const amount = centsToMoney(amountMinor);
  const key = normalizeIdempotencyKey(input.executionKey);

  /** Replay the ORIGINAL result from a persisted row, proving the same card + owner. */
  const replay = (row: CardConsumptionRow): ConsumeCardResult => {
    if (row.cardId !== cardId || row.userId !== userId) {
      throw new AppError('CONFLICT', '该执行身份不属于本次卡消费。', { executionKey: key });
    }
    const snapshot = safeParse<ConsumeCardResult | null>(row.resultJson, null);
    if (!snapshot) throw new AppError('CONFLICT', '卡消费结果快照缺失，无法重放。', { executionKey: key });
    return snapshot;
  };

  try {
    return await runInTransaction(async (tx): Promise<ConsumeCardResult> => {
      if (key !== undefined) {
        const existing = await tx.cardConsumption.findUnique({ where: { executionKey: key } });
        // A committed row under this identity is a replay ONLY when it belongs to the SAME card/owner;
        // its persisted snapshot is returned VERBATIM (no second charge).
        if (existing) return replay(existing);
      }

      const card = await tx.card.findFirst({ where: { id: cardId, userId } });
      if (!card) throw new AppError('NOT_FOUND', `卡片不存在：${cardId}`, { cardId });
      if (card.status !== 'ACTIVE') {
        throw new AppError('CONFLICT', '卡片状态不允许消费。', { cardId, status: card.status });
      }

      // The settlement binding is re-validated in-transaction (existence + ownership + account type)
      // and, for a replacement card minted without one, restored from its explicit 补办 link and
      // persisted. A MISSING binding (nothing recorded, nothing recoverable) and an UNTRUSTED one (a
      // recorded account that no longer resolves to an owned CHECKING account) are BOTH fatal, with
      // distinct messages; neither ever degrades into "the user's default account".
      const account = await resolveSettlementAccount(tx, card);
      if (!account) {
        throw new AppError('CONFLICT', '该卡片未绑定结算账户（MISSING），无法消费。', { cardId, linkedAccountStatus: 'MISSING' });
      }

      // Monthly limit: the current billing month's spend of the whole replacement FAMILY, read at
      // the SAME server instant this spend is booked at.
      if (card.monthlyLimitMinor !== null) {
        const spentMinor = await cardFamilyMonthSpend(tx, cardId, userId, at);
        if (spentMinor + amountMinor > card.monthlyLimitMinor) {
          throw new AppError('LIMIT_EXCEEDED', '超过虚拟卡月限额。', {
            cardId,
            monthlyLimit: centsToMoney(card.monthlyLimitMinor),
            spent: centsToMoney(spentMinor),
            amount,
          });
        }
      }

      // Atomic sufficient-funds check + debit (never overdraft under concurrency).
      const debited = await tx.account.updateMany({
        where: { id: account.id, userId, balanceMinor: { gte: amountMinor } },
        data: { balanceMinor: { decrement: amountMinor } },
      });
      if (debited.count === 0) {
        const current = await tx.account.findUnique({ where: { id: account.id } });
        throw new AppError('INSUFFICIENT_FUNDS', `余额不足：${centsToMoney(current?.balanceMinor ?? 0n)} < ${amount}`, {
          balance: centsToMoney(current?.balanceMinor ?? 0n),
          amount,
        });
      }

      await tx.transaction.create({ data: {
        accountId: account.id,
        userId,
        amountMinor: -amountMinor,
        direction: 'DEBIT',
        category,
        merchant,
        channel: 'CARD',
        occurredAt: new Date(at),
        currency: 'CNY',
      } });

      const created = await tx.cardConsumption.create({ data: {
        cardId,
        accountId: account.id,
        userId,
        amountMinor,
        currency: 'CNY',
        category,
        merchant,
        occurredAt: new Date(at),
        executionKey: key ?? null,
      } });

      const updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
      const cardView = await loadCardView(await tx.card.findUniqueOrThrow({ where: { id: card.id } }), at);
      const snapshot: ConsumeCardResult = {
        consumption: toConsumptionView(created),
        card: cardView,
        accountAvailableBalance: centsToMoney(updatedAccount.balanceMinor),
      };
      // Persist the ORIGINAL result on the row so a same-key replay reproduces it exactly.
      await tx.cardConsumption.update({ where: { id: created.id }, data: { resultJson: toJson(snapshot) } });
      return snapshot;
    });
  } catch (error) {
    // Concurrent same-key race: the other call committed the consumption first → our tx rolled back
    // (the debit undone). Re-read the committed row and replay it, or rethrow.
    if (key !== undefined && isUniqueViolation(error)) {
      const committed = await runInTransaction((tx) => tx.cardConsumption.findUnique({ where: { executionKey: key } }));
      if (committed) return replay(committed);
    }
    throw error;
  }
}

/** Card consumptions owned by the user, newest first (optional card filter; default 20, max 200). */
export async function listCardConsumptions(
  userId: string,
  query: CardConsumptionQuery = {},
): Promise<CardConsumptionView[]> {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new AppError('SECURITY_DENIED', '缺少卡片消费查询用户身份。');
  }

  const rawCardId = query.cardId;
  const cardId = typeof rawCardId === 'string' ? rawCardId.trim() : undefined;
  if (rawCardId !== undefined && cardId === '') {
    throw new AppError('VALIDATION', '卡片消费查询的 cardId 必须是非空文本。', { cardId: rawCardId });
  }
  const limit = query.limit === undefined ? DEFAULT_CONSUMPTION_LIMIT : query.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new AppError('VALIDATION', '卡片消费查询 limit 必须是正整数。', { limit: query.limit });
  }

  return runInTransaction(async (tx) => {
    const rows = await tx.cardConsumption.findMany({
      where: { userId, ...(cardId !== undefined ? { cardId } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(limit, MAX_CONSUMPTION_LIMIT),
    });
    return rows.map(toConsumptionView);
  });
}

/**
 * Build a masked card number (`****` + 4 random digits) that does not collide with any of the
 * user's existing masks. Throws `AppError('INTERNAL')` if that proves impossible (never silently
 * returns a duplicate).
 */
function generateMaskedNumber(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const masked = `****${suffix}`;
    if (!existing.has(masked)) return masked;
  }
  throw new AppError('INTERNAL', '无法生成唯一的虚拟卡卡号', { attempts: 20 });
}

/**
 * The identity of a card about to be MINTED: a server-generated FICTIONAL complete number plus the
 * masked display value DERIVED from that same number through `lib/mask.ts` (the masking algorithm is
 * reused, never re-implemented here).
 *
 * The four-digit tail comes from `generateMaskedNumber`, so its contract is preserved: a new card's
 * trailing four digits are unique among the owner's existing cards — including a tail that lives only
 * in a legacy row's `numberFull` — and, because the complete number is `6222` + zeros + that tail,
 * distinct tails are also distinct complete numbers. Two cards minted by this module can therefore
 * never share a `cardNumber` or a `cardTail` selector, so the SDK itself never creates an ambiguity
 * `security/card-resolution.ts` would have to refuse.
 *
 * Only NEW rows get this value; an existing row's display value is never rewritten.
 */
function generateCardIdentity(own: readonly CardRow[]): { numberFull: string; numberMasked: string } {
  const taken = new Set<string>();
  for (const card of own) {
    taken.add(card.numberMasked);
    // A row may record a complete number its display value does not show; its tail is taken too.
    if (typeof card.numberFull === 'string' && card.numberFull !== '') {
      taken.add(maskCardNumber(card.numberFull.slice(-CARD_MASK_SOURCE_LENGTH)));
    }
  }
  const unique = generateMaskedNumber(taken);
  const middle = '0'.repeat(FICTIONAL_CARD_NUMBER_LENGTH - FICTIONAL_CARD_BIN.length - 4);
  const numberFull = `${FICTIONAL_CARD_BIN}${middle}${unique.slice(-4)}`;
  return { numberFull, numberMasked: maskCardNumber(numberFull.slice(-CARD_MASK_SOURCE_LENGTH)) };
}
