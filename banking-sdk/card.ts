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
 * Virtual cards are ACCOUNT-BOUND: `applyVirtualCard`/`addDemoCard` bind a settlement CHECKING
 * account (`Card.linkedAccountId`), and `consumeCard` is the single SDK capability that spends from
 * a card — it debits that account with an atomic sufficient-funds write and writes a `channel='CARD'`
 * ledger row plus a `CardConsumption` row in ONE transaction, guarded by the card's monthly limit.
 */
import type {
  Account as AccountRow,
  Card as CardRow,
  CardConsumption as CardConsumptionRow,
  CardLimit as CardLimitRow,
} from '@/lib/db/prisma';
import { accounts, cards } from '../lib/db/repositories';
import { dbClient } from '../lib/db/client';
import { AppError } from '../lib/errors';
import { centsToMoney, moneyToCents } from '../lib/money';
import { demoMonthRange, demoNow } from '../lib/clock';
import { idempotentCardId, isUniqueViolation, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction, type Tx } from './tx';
import type { AddDemoCardRequest } from '../lib/contracts/card-management';
import { safeParse, toJson } from '../lib/json';
import { SPENDING_CATEGORIES } from './categories';
import type {
  ApplyVirtualCardInput,
  CardConsumptionQuery,
  CardConsumptionView,
  CardStatus,
  CardType,
  CardView,
  ConsumeCardInput,
  ConsumeCardResult,
  ReportLostCardInput,
  SetCardLimitInput,
} from './types';

/** Network of a newly issued virtual card (demo sandbox). */
const VIRTUAL_CARD_NETWORK = 'UnionPay';

/** Merchant label used when a card consumption omits one (local simulation only). */
const DEFAULT_CONSUME_MERCHANT = '本地模拟消费';

/** Page size for card-consumption reads when no limit is supplied. */
const DEFAULT_CONSUMPTION_LIMIT = 20;
/** Hard cap on card-consumption reads. */
const MAX_CONSUMPTION_LIMIT = 200;

/** Extra, non-row data the enriched projection needs for an ACCOUNT-BOUND card. */
interface CardViewExtras {
  account: AccountRow;
  spentMinor: bigint;
}

/** Map a Prisma card row + its category limits onto the frozen `CardView` DTO. */
function toCardView(row: CardRow, limits: CardLimitRow[], extras?: CardViewExtras): CardView {
  const view: CardView = {
    id: row.id,
    type: row.type as CardType,
    network: row.network,
    numberMasked: row.numberMasked,
    status: row.status as CardStatus,
    creditLimit: row.creditLimitMinor === null ? undefined : centsToMoney(row.creditLimitMinor),
    availableLimit: row.availableLimitMinor === null ? undefined : centsToMoney(row.availableLimitMinor),
    monthlyLimit: row.monthlyLimitMinor === null ? undefined : centsToMoney(row.monthlyLimitMinor),
    replacedByCardId: row.replacedByCardId ?? undefined,
    linkedAccountId: row.linkedAccountId ?? undefined,
    limits: limits.map((limit) => ({ category: limit.category, amount: centsToMoney(limit.amountMinor) })),
  };
  if (!row.linkedAccountId || !extras) return view;

  const availableMinor = extras.account.balanceMinor;
  // Remaining monthly allowance; a null monthly limit means unlimited (balance-governed only).
  const remaining = row.monthlyLimitMinor === null
    ? undefined
    : (row.monthlyLimitMinor > extras.spentMinor ? row.monthlyLimitMinor - extras.spentMinor : 0n);
  const payableMinor = remaining === undefined
    ? availableMinor
    : (availableMinor < remaining ? availableMinor : remaining);

  view.linkedAccountNumber = extras.account.number;
  view.accountAvailableBalance = centsToMoney(availableMinor);
  view.payableAmount = centsToMoney(payableMinor);
  return view;
}

/**
 * Sum of this card's `CardConsumption` rows within the current business month (CNY minor units).
 * Uses the demo (UTC+08:00) calendar so the monthly limit and the spend analysis agree.
 */
async function spentThisMonthMinor(cardId: string): Promise<bigint> {
  const { start, end } = demoMonthRange();
  const rows = await dbClient().cardConsumption.findMany({
    where: { cardId, occurredAt: { gte: start, lt: end } },
    select: { amountMinor: true },
  });
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

/**
 * Map a card row onto a `CardView`, loading its per-category limits and — for an account-bound card
 * — the linked account's masked number, balance and current payable amount. This is the single
 * async enriched mapper every CardView-returning function uses.
 */
async function loadCardView(row: CardRow): Promise<CardView> {
  const limits = await cards.listCardLimits(row.id);
  if (!row.linkedAccountId) return toCardView(row, limits);
  const account = await accounts.getAccount(row.linkedAccountId);
  if (!account) return toCardView(row, limits);
  return toCardView(row, limits, { account, spentMinor: await spentThisMonthMinor(row.id) });
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
 * Resolve the settlement account a card is (or must be) bound to.
 * An explicit `requestedId` must name one of the user's CHECKING accounts; when omitted the user's
 * default CHECKING account is used. Ownership and type are enforced here — never by the model.
 */
async function resolveLinkedAccount(tx: Tx, userId: string, requestedId?: string): Promise<AccountRow> {
  const requested = typeof requestedId === 'string' ? requestedId.trim() : '';
  if (requested !== '') {
    const account = await tx.account.findUnique({ where: { id: requested } });
    if (!account || account.userId !== userId) {
      throw new AppError('SECURITY_DENIED', '绑定的结算账户不存在或不属于该用户。', { linkedAccountId: requestedId });
    }
    if (account.type !== 'CHECKING') {
      throw new AppError('VALIDATION', '虚拟卡只能绑定活期账户。', { linkedAccountId: account.id, type: account.type });
    }
    return account;
  }
  const fallback = await tx.account.findFirst({ where: { userId, type: 'CHECKING' }, orderBy: { id: 'asc' } });
  if (!fallback) throw new AppError('VALIDATION', '没有可用于绑定虚拟卡的活期账户', { userId });
  return fallback;
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
    return Promise.all(rows.map(loadCardView));
  });
}

/** Create a simulated record only; the dedicated manual command owns MFA, audit and replay. */
export async function addDemoCard(userId: string, input: Omit<AddDemoCardRequest, 'requestId'>): Promise<CardView> {
  if (!['DEBIT', 'CREDIT', 'VIRTUAL'].includes(input.type)) throw new AppError('VALIDATION', 'Invalid card type.');
  const creditLimitMinor = input.creditLimit === undefined ? null : moneyToCents(input.creditLimit);
  const monthlyLimitMinor = input.monthlyLimit === undefined ? null : moneyToCents(input.monthlyLimit);
  if (input.type === 'CREDIT' && (creditLimitMinor === null || creditLimitMinor <= 0n)) throw new AppError('VALIDATION', 'A credit card requires a positive credit limit.');
  if (input.type !== 'CREDIT' && creditLimitMinor !== null) throw new AppError('VALIDATION', 'Only credit cards accept a credit limit.');
  if (monthlyLimitMinor !== null && monthlyLimitMinor < 0n) throw new AppError('VALIDATION', 'Monthly limit must be non-negative.');
  return runInTransaction(async tx => {
    const linkedAccountId = input.type === 'VIRTUAL'
      ? (await resolveLinkedAccount(tx, userId, input.linkedAccountId)).id
      : null;
    const own = await tx.card.findMany({ where: { userId } });
    const row = await tx.card.create({ data: { userId, type: input.type, network: 'UnionPay',
      numberMasked: generateMaskedNumber(new Set(own.map(card => card.numberMasked))), status: 'ACTIVE',
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
 * The replacement is a fresh row with a new masked number. It carries the source's monthly limit,
 * and a CREDIT replacement also inherits the source's approved credit limit and current available limit
 * (per-category limits are NOT copied). The source stays `LOST` and records the new card id in
 * `replacedByCardId` — a historical reference, not a status change and not a relation.
 *
 * Idempotent: inside ONE transaction a source that already points at a replacement returns that
 * existing card instead of issuing a second one (a plan node may be replayed after a resume).
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
    if (latest.replacedByCardId) {
      const existing = await tx.card.findUnique({ where: { id: latest.replacedByCardId, userId } });
      if (!existing) {
        throw new AppError('CONFLICT', '补卡记录不一致：原卡片关联的补办卡不存在。', {
          cardId: latest.id,
          replacedByCardId: latest.replacedByCardId,
        });
      }
      return toCardView(existing, await tx.cardLimit.findMany({ where: { cardId: existing.id } }));
    }
    const own = await tx.card.findMany({ where: { userId } });
    const created = await tx.card.create({ data: {
      userId,
      type: latest.type,
      network: latest.network,
      numberMasked: generateMaskedNumber(new Set(own.map(card => card.numberMasked))),
      status: 'ACTIVE',
      // A replacement CREDIT card inherits the SAME approved credit limit and current available
      // limit (no re-approval); non-credit cards keep none.
      creditLimitMinor: latest.type === 'CREDIT' ? latest.creditLimitMinor : null,
      availableLimitMinor: latest.type === 'CREDIT' ? latest.availableLimitMinor : null,
      monthlyLimitMinor: latest.monthlyLimitMinor,
    } });
    await tx.card.update({ where: { id: latest.id, userId }, data: { replacedByCardId: created.id } });
    return toCardView(created, []);
  });
}

/**
 * Issue a new virtual card bound to a settlement CHECKING account; returns the created card.
 * The masked number is generated as `****` + 4 digits, avoiding the user's existing masks.
 * `monthlyLimit` is an explicit cent-valid configuration saved at creation.
 *
 * The settlement account is `input.linkedAccountId` (validated for ownership + CHECKING type) or,
 * when omitted, the user's default CHECKING account — never inferred from a free-text label.
 *
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
      return tx.card.create({ data: {
        userId,
        type: 'VIRTUAL',
        network: VIRTUAL_CARD_NETWORK,
        numberMasked: generateMaskedNumber(new Set(own.map((card) => card.numberMasked))),
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
      const numberMasked = generateMaskedNumber(new Set(own.map((card) => card.numberMasked)));

      return tx.card.create({
        data: {
          id: cardId,
          userId,
          type: 'VIRTUAL',
          network: VIRTUAL_CARD_NETWORK,
          numberMasked,
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
 * Spend from an owned, account-bound virtual card.
 *
 * Inside ONE transaction: replay the persisted consumption when the execution identity matches; else
 * re-validate the card (owned, bound, `ACTIVE`) and its settlement account (owned, `CHECKING`),
 * enforce the card's monthly limit, debit the account with an atomic sufficient-funds write, write a
 * `channel='CARD'` ledger row and a `CardConsumption` row, and persist the original result snapshot
 * for same-key replay. `moneyToCents` keeps every amount an exact integer CNY minor unit.
 */
export async function consumeCard(input: ConsumeCardInput): Promise<ConsumeCardResult> {
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

  const occurredAt = input?.occurredAt === undefined ? demoNow() : input.occurredAt;
  if (typeof occurredAt !== 'number' || !Number.isInteger(occurredAt)) {
    throw new AppError('VALIDATION', '消费时间必须是整数毫秒时间戳。', { occurredAt: input?.occurredAt });
  }

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
      if (card.linkedAccountId === null) {
        throw new AppError('CONFLICT', '该卡片未绑定结算账户，无法消费。', { cardId });
      }
      if (card.status !== 'ACTIVE') {
        throw new AppError('CONFLICT', '卡片状态不允许消费。', { cardId, status: card.status });
      }

      // Re-validate the persisted binding in-transaction (ownership + account type).
      const account = await tx.account.findFirst({ where: { id: card.linkedAccountId, userId } });
      if (!account) {
        throw new AppError('CONFLICT', '卡片绑定的结算账户不存在或不属于该用户。', { cardId, linkedAccountId: card.linkedAccountId });
      }
      if (account.type !== 'CHECKING') {
        throw new AppError('CONFLICT', '卡片绑定的账户不是活期账户。', { cardId, accountId: account.id, type: account.type });
      }

      // Monthly limit: re-read the card's current month spend for the demo business month.
      if (card.monthlyLimitMinor !== null) {
        const { start, end } = demoMonthRange();
        const spentRows = await tx.cardConsumption.findMany({
          where: { cardId, occurredAt: { gte: start, lt: end } },
          select: { amountMinor: true },
        });
        const spentMinor = spentRows.reduce((total, row) => total + row.amountMinor, 0n);
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
        occurredAt: new Date(occurredAt),
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
        occurredAt: new Date(occurredAt),
        executionKey: key ?? null,
      } });

      const updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
      const cardView = await loadCardView(await tx.card.findUniqueOrThrow({ where: { id: card.id } }));
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
