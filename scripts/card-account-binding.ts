/**
 * One-time backfill: bind legacy account-funded cards to the CHECKING account they spend from.
 *
 * A DEBIT/VIRTUAL card draws on exactly one owned CHECKING account through the scalar
 * `Card.linkedAccountId` reference. Cards created before that reference existed carry an empty
 * value, so a consumption cannot resolve a funding account. This script fills it in.
 *
 * The script stays on scalar columns only (`Card.linkedAccountId` + `prisma.account.findMany`), so
 * it works whether or not `linkedAccountId` is also exposed as a Prisma relation.
 *
 * Safety rules:
 * - Only cards with `linkedAccountId IS NULL` are scanned; CREDIT cards are skipped because they
 *   draw on a credit limit, never on account cash.
 * - The ONE heuristic is explicit and never guesses: a user's own CHECKING accounts are read, and
 *   the card is bound only when the user owns exactly one. Zero accounts and several accounts are
 *   skipped and reported (`no-checking-account` / `ambiguous-checking-accounts`).
 * - Every planned account is re-read by id and must still exist, belong to the same user and be
 *   CHECKING (`unowned-account`), so no hard-coded account whitelist is involved.
 * - Writes are compare-and-set (`linkedAccountId: null` in the WHERE clause). A concurrent binder
 *   wins and this run reports the card as `already-bound` instead of overwriting it, which also
 *   makes a repeated run idempotent.
 * - `--dry-run` prints the plan and writes nothing. A real run records a replayable manifest under
 *   `logs/card-account-binding/`; `--rollback=<file>` restores only rows that still hold the value
 *   this script wrote, so later manual edits are never overwritten.
 * - Output only contains already-masked values from the database (`Account.number`, e.g.
 *   `****8821`); no full account number, card number, environment value or key is printed.
 *
 * Invoke through pnpm tsx (the default run applies the backfill):
 *   pnpm tsx scripts/card-account-binding.ts --dry-run
 *   pnpm tsx scripts/card-account-binding.ts
 *   pnpm tsx scripts/card-account-binding.ts --rollback=logs/card-account-binding/<stamp>-applied.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nextEnv from '@next/env';
import type { PrismaClient } from '../lib/db/prisma.ts';

const { loadEnvConfig } = nextEnv;

/** Temporary artifacts (including rollback manifests) stay under the ignored `logs/` directory. */
const ROLLBACK_DIRECTORY = path.join('logs', 'card-account-binding');

/** Card types that spend an account's cash and therefore need a linked CHECKING account. */
const ACCOUNT_FUNDED_CARD_TYPES: readonly string[] = ['DEBIT', 'VIRTUAL'];

/** Why a scanned card was not bound. Every reason is reported, none is silently dropped. */
export type SkipReason =
  | 'credit-card'
  | 'no-checking-account'
  | 'ambiguous-checking-accounts'
  | 'unowned-account'
  | 'already-bound';

export interface SkippedCard {
  cardId: string;
  reason: SkipReason;
  detail?: string;
}

/** The minimal account projection used for a binding; `number` is already masked in storage. */
export interface BindingAccount {
  id: string;
  userId: string;
  type: string;
  name: string;
  number: string;
}

export interface PlannedBinding {
  cardId: string;
  userId: string;
  account: BindingAccount;
}

export interface BindingReport {
  dryRun: boolean;
  scanned: number;
  bindings: PlannedBinding[];
  skipped: SkippedCard[];
  rollbackFile: string | null;
}

/** One row of the rollback manifest: what this script wrote and what it replaced. */
export interface RollbackChange {
  cardId: string;
  previousLinkedAccountId: string | null;
  linkedAccountId: string;
  accountId: string;
}

export interface BindingCliOptions {
  help: boolean;
  dryRun: boolean;
  rollbackFile: string | null;
}

export interface RollbackResult {
  file: string;
  restored: number;
  unmatched: number;
}

/** Parse the non-interactive CLI surface; anything unknown is a hard usage error. */
export function parseCardAccountBindingArguments(args: readonly string[]): BindingCliOptions {
  const options: BindingCliOptions = { help: false, dryRun: false, rollbackFile: null };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--rollback' || flag.startsWith('--rollback=')) {
      const value = flag === '--rollback' ? args[++index] : flag.slice('--rollback='.length);
      if (!value) throw new Error('--rollback requires the path of an applied-changes JSON file.');
      options.rollbackFile = value;
      continue;
    }
    throw new Error(`Unsupported card account binding argument: ${flag}`);
  }
  if (options.rollbackFile !== null && options.dryRun) {
    throw new Error('--dry-run cannot be combined with --rollback.');
  }
  return options;
}

export function formatUsage(): string {
  return [
    'Usage: pnpm tsx scripts/card-account-binding.ts [--dry-run | --rollback=<applied.json>]',
    '',
    '  (no flag)      bind the cards, then write a rollback manifest under logs/card-account-binding/',
    '  --dry-run      print the planned bindings without writing to the database',
    '  --rollback=<f> restore the bindings recorded in a manifest written by an earlier real run',
    '  --help         print this usage text',
    '',
    'Only cards of type DEBIT/VIRTUAL with an empty linkedAccountId are treated as candidates and are',
    'bound only when the owning user has exactly one CHECKING account.',
    '',
  ].join('\n');
}

function isAccountFundedCard(type: string): boolean {
  return ACCOUNT_FUNDED_CARD_TYPES.includes(type);
}

/** Read every card whose funding reference is empty; only scalar columns are read, never relations. */
async function collectUnboundCards(prisma: PrismaClient): Promise<Array<{ id: string; userId: string; type: string }>> {
  return prisma.card.findMany({
    where: { linkedAccountId: null },
    select: { id: true, userId: true, type: true },
    orderBy: { id: 'asc' },
  });
}

/**
 * Apply the single documented heuristic: bind to the user's own CHECKING account only when exactly
 * one exists. More than one is ambiguous and is never guessed; none means there is nothing to bind
 * (a SAVINGS account is never a candidate because it is filtered out by `type`).
 */
async function planBindings(
  prisma: PrismaClient,
  cards: ReadonlyArray<{ id: string; userId: string; type: string }>,
): Promise<{ planned: PlannedBinding[]; skipped: SkippedCard[] }> {
  const skipped: SkippedCard[] = [];
  const candidates: Array<{ id: string; userId: string }> = [];
  for (const card of cards) {
    if (!isAccountFundedCard(card.type)) {
      skipped.push({
        cardId: card.id,
        reason: 'credit-card',
        detail: card.type === 'CREDIT' ? undefined : `type=${card.type}`,
      });
      continue;
    }
    candidates.push(card);
  }
  if (candidates.length === 0) return { planned: [], skipped };

  const userIds = [...new Set(candidates.map(card => card.userId))];
  const checkingAccounts = await prisma.account.findMany({
    where: { userId: { in: userIds }, type: 'CHECKING' },
    select: { id: true, userId: true, type: true, name: true, number: true },
    orderBy: { id: 'asc' },
  });
  const accountsByUser = new Map<string, BindingAccount[]>();
  for (const account of checkingAccounts) {
    const bucket = accountsByUser.get(account.userId);
    if (bucket) bucket.push(account);
    else accountsByUser.set(account.userId, [account]);
  }

  const planned: PlannedBinding[] = [];
  for (const card of candidates) {
    const accounts = accountsByUser.get(card.userId) ?? [];
    if (accounts.length === 0) {
      skipped.push({ cardId: card.id, reason: 'no-checking-account' });
      continue;
    }
    if (accounts.length > 1) {
      skipped.push({ cardId: card.id, reason: 'ambiguous-checking-accounts', detail: `${accounts.length} CHECKING accounts` });
      continue;
    }
    planned.push({ cardId: card.id, userId: card.userId, account: accounts[0] });
  }
  return { planned, skipped };
}

/** Re-read each planned account by id and confirm it still exists, is owned and is CHECKING. */
async function validatePlans(
  prisma: PrismaClient,
  planned: readonly PlannedBinding[],
): Promise<{ valid: PlannedBinding[]; skipped: SkippedCard[] }> {
  if (planned.length === 0) return { valid: [], skipped: [] };
  const accountIds = [...new Set(planned.map(plan => plan.account.id))];
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, userId: true, type: true, name: true, number: true },
  });
  const byId = new Map(accounts.map(account => [account.id, account]));
  const valid: PlannedBinding[] = [];
  const skipped: SkippedCard[] = [];
  for (const plan of planned) {
    const account = byId.get(plan.account.id);
    if (!account || account.userId !== plan.userId || account.type !== 'CHECKING') {
      skipped.push({ cardId: plan.cardId, reason: 'unowned-account', detail: `account=${plan.account.id}` });
      continue;
    }
    valid.push({ cardId: plan.cardId, userId: plan.userId, account });
  }
  return { valid, skipped };
}

/**
 * Compare-and-set each binding: the WHERE clause requires the reference to still be empty, so a
 * concurrent write wins and this run reports `already-bound` instead of overwriting it.
 */
async function applyBindings(
  prisma: PrismaClient,
  bindings: readonly PlannedBinding[],
): Promise<{ applied: PlannedBinding[]; skipped: SkippedCard[] }> {
  const applied: PlannedBinding[] = [];
  const skipped: SkippedCard[] = [];
  for (const binding of bindings) {
    const { count } = await prisma.card.updateMany({
      where: { id: binding.cardId, userId: binding.userId, linkedAccountId: null },
      data: { linkedAccountId: binding.account.id },
    });
    if (count === 0) {
      skipped.push({ cardId: binding.cardId, reason: 'already-bound' });
      continue;
    }
    applied.push(binding);
  }
  return { applied, skipped };
}

/** Write the replayable rollback manifest; a real run creates the directory recursively. */
function writeRollbackManifest(applied: readonly PlannedBinding[], appliedAt: string): string {
  mkdirSync(ROLLBACK_DIRECTORY, { recursive: true });
  const stamp = appliedAt.replace(/[:.]/g, '-');
  const file = path.join(ROLLBACK_DIRECTORY, `${stamp}-applied.json`);
  const changes: RollbackChange[] = applied.map(binding => ({
    cardId: binding.cardId,
    previousLinkedAccountId: null,
    linkedAccountId: binding.account.id,
    accountId: binding.account.id,
  }));
  writeFileSync(file, `${JSON.stringify({ appliedAt, changes }, null, 2)}\n`, 'utf8');
  // Forward slashes keep the printed rollback command usable in every shell.
  return file.split(path.sep).join('/');
}

/** Scan, plan, validate and (unless dry-run) apply the backfill. */
export async function runBindingBackfill(prisma: PrismaClient, dryRun: boolean): Promise<BindingReport> {
  const cards = await collectUnboundCards(prisma);
  const planned = await planBindings(prisma, cards);
  const validated = await validatePlans(prisma, planned.planned);
  const skipped = [...planned.skipped, ...validated.skipped];
  if (dryRun) {
    return { dryRun: true, scanned: cards.length, bindings: validated.valid, skipped, rollbackFile: null };
  }
  const written = await applyBindings(prisma, validated.valid);
  const bindings = written.applied;
  const rollbackFile = bindings.length > 0 ? writeRollbackManifest(bindings, new Date().toISOString()) : null;
  return { dryRun: false, scanned: cards.length, bindings, skipped: [...skipped, ...written.skipped], rollbackFile };
}

export function formatBindingSummary(report: BindingReport): string {
  const lines: string[] = [];
  lines.push('Card account binding backfill');
  lines.push(report.dryRun ? 'mode: DRY RUN (nothing is written)' : 'mode: APPLY');
  lines.push(`scanned: ${report.scanned} card(s) with an empty linkedAccountId`);
  lines.push(`${report.dryRun ? 'would bind' : 'bound'}: ${report.bindings.length}`);
  for (const binding of report.bindings) {
    // Only the stored masked account number is printed, never a full account or card number.
    lines.push(`  ${binding.cardId} -> ${binding.account.id} (${binding.account.name}, ${binding.account.number})`);
  }
  lines.push(`skipped: ${report.skipped.length}`);
  const reasons: readonly SkipReason[] = [
    'credit-card', 'no-checking-account', 'ambiguous-checking-accounts', 'unowned-account', 'already-bound',
  ];
  for (const reason of reasons) {
    const entries = report.skipped.filter(entry => entry.reason === reason);
    if (entries.length === 0) continue;
    lines.push(`  ${reason}: ${entries.length}`);
    for (const entry of entries) lines.push(`    ${entry.cardId}${entry.detail ? ` (${entry.detail})` : ''}`);
  }
  if (report.rollbackFile) {
    lines.push(`rollback file: ${report.rollbackFile}`);
    lines.push(`rollback command: pnpm tsx scripts/card-account-binding.ts --rollback=${report.rollbackFile}`);
  } else {
    lines.push(`rollback file: none (${report.dryRun ? 'dry run' : 'no changes were written'})`);
  }
  return `${lines.join('\n')}\n`;
}

/** Read and validate a manifest written by {@link writeRollbackManifest}. Invalid input is fatal. */
export function parseRollbackManifest(filePath: string): RollbackChange[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read rollback file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Rollback file ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { changes?: unknown }).changes)) {
    throw new Error(`Rollback file ${filePath} must contain a "changes" array.`);
  }
  const changes = (parsed as { changes: unknown[] }).changes;
  return changes.map((entry, index) => {
    const change = entry as Partial<RollbackChange> | null;
    if (typeof change !== 'object' || change === null) throw new Error(`Rollback file ${filePath}: changes[${index}] is not an object.`);
    const { cardId, linkedAccountId, previousLinkedAccountId } = change;
    if (typeof cardId !== 'string' || cardId === '') throw new Error(`Rollback file ${filePath}: changes[${index}].cardId is missing.`);
    if (typeof linkedAccountId !== 'string' || linkedAccountId === '') {
      throw new Error(`Rollback file ${filePath}: changes[${index}].linkedAccountId is missing.`);
    }
    if (previousLinkedAccountId !== null && previousLinkedAccountId !== undefined && typeof previousLinkedAccountId !== 'string') {
      throw new Error(`Rollback file ${filePath}: changes[${index}].previousLinkedAccountId must be a string or null.`);
    }
    return { cardId, linkedAccountId, previousLinkedAccountId: previousLinkedAccountId ?? null, accountId: linkedAccountId };
  });
}

/**
 * Restore the recorded binding only while the row still holds the value this script wrote, so a
 * later manual re-bind is never overwritten by a stale manifest.
 */
export async function rollbackBindings(prisma: PrismaClient, filePath: string): Promise<RollbackResult> {
  const changes = parseRollbackManifest(filePath);
  let restored = 0;
  let unmatched = 0;
  for (const change of changes) {
    const { count } = await prisma.card.updateMany({
      where: { id: change.cardId, linkedAccountId: change.linkedAccountId },
      data: { linkedAccountId: change.previousLinkedAccountId },
    });
    if (count > 0) restored += 1;
    else unmatched += 1;
  }
  return { file: filePath, restored, unmatched };
}

export function formatRollbackSummary(result: RollbackResult): string {
  return [
    'Card account binding rollback',
    `manifest: ${result.file}`,
    `restored: ${result.restored}`,
    `unmatched (row no longer holds the written value): ${result.unmatched}`,
    '',
  ].join('\n');
}

/**
 * Entry point. Exit codes: 0 for a completed run (dry run, apply with skips, rollback), non-zero for
 * a usage error, an unusable manifest, an unavailable database or any other uncaught failure.
 */
export async function runCardAccountBinding(args = process.argv.slice(2)): Promise<void> {
  const options = parseCardAccountBindingArguments(args);
  if (options.help) {
    process.stdout.write(formatUsage());
    return;
  }
  // Load the application configuration without printing values, then resolve the client lazily.
  loadEnvConfig(process.cwd(), false, {
    info: () => undefined,
    error: () => { throw new Error('Environment configuration could not be loaded.'); },
  });
  const { prisma } = await import('../lib/db/client');
  try {
    if (options.rollbackFile !== null) {
      process.stdout.write(formatRollbackSummary(await rollbackBindings(prisma, options.rollbackFile)));
      return;
    }
    process.stdout.write(formatBindingSummary(await runBindingBackfill(prisma, options.dryRun)));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCardAccountBinding().catch(error => {
    process.stderr.write(`Card account binding failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
