/**
 * One-time backfill: fill the server-only `Contact.phoneFull` / `Card.numberFull` columns.
 *
 * The two columns hold a COMPLETE (unmasked) fictional test number so that a server-side recipient
 * match can compare complete numbers exactly. They are NEVER projected: `toContactView` /
 * `toCardView` read the masked display columns only (`phone` / `numberMasked`), and this script only
 * ever PRINTS masked values.
 *
 * Safety rules:
 * - Only rows whose full-number column is still empty are scanned (`phoneFull: null` /
 *   `numberFull: null`); rows a user created with a value are never touched.
 * - The ONE allowed completion is a COPY, never a derivation: when the display column is ITSELF a
 *   complete value (`1[3-9]\d{9}` for a phone, 12–19 digits for a card) it is copied into the new
 *   column and the display column is normalized through `lib/mask.ts` (`maskPhone` /
 *   `maskCardNumber`) — the masking implementation is reused, never re-implemented here.
 * - A masked display value (`139****0002`, `****8821`) is NEVER expanded into a guessed number:
 *   those rows are reported as `unrecoverable-masked`. Anything that is neither complete nor masked
 *   is reported as `unrecognized-format`. Both lists are printed record by record.
 * - Writes are compare-and-set (`phoneFull`/`numberFull` still NULL AND the display value unchanged).
 *   A concurrent writer wins and this run reports the row as `already-complete` or `display-changed`,
 *   which also makes a repeated run idempotent (a second run completes nothing).
 * - `--dry-run` prints the plan and writes nothing. A real run records a replayable manifest under
 *   `logs/number-backfill/`; `--rollback=<file>` clears only rows that still hold the value this
 *   script wrote, so a later manual edit is never overwritten. The masked normalization of the
 *   display column is intentionally NOT reverted: it only ever reduces exposure.
 * - No full number, environment value or API key is printed.
 *
 * Invoke through pnpm tsx (the default run applies the backfill):
 *   pnpm tsx scripts/number-backfill.ts --dry-run
 *   pnpm tsx scripts/number-backfill.ts
 *   pnpm tsx scripts/number-backfill.ts --rollback=logs/number-backfill/<stamp>-applied.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import nextEnv from '@next/env';
import type { PrismaClient } from '../lib/db/prisma.ts';
import { maskCardNumber, maskPhone } from '../lib/mask';

const { loadEnvConfig } = nextEnv;

/** Temporary artifacts (including rollback manifests) stay under the ignored `logs/` directory. */
const ROLLBACK_DIRECTORY = path.join('logs', 'number-backfill');

/** A complete, normalized mainland mobile number. */
const COMPLETE_PHONE = /^1[3-9]\d{9}$/;
/** A complete card number: 12–19 digits, matching the stored `numberMasked` length range. */
const COMPLETE_CARD_NUMBER = /^\d{12,19}$/;

/** Which column pair a record belongs to. */
export type FullNumberKind = 'contact-phone' | 'card-number';

/** The record kinds in report order. */
const KINDS: readonly FullNumberKind[] = ['contact-phone', 'card-number'];

/** Why a scanned row was not completed. Every reason is reported, none is silently dropped. */
export type SkipReason =
  | 'unrecoverable-masked'
  | 'unrecognized-format'
  | 'already-complete'
  | 'display-changed';

/** Report order of the skip reasons (scan-side reasons first, then compare-and-set outcomes). */
const SKIP_REASONS: readonly SkipReason[] = [
  'unrecoverable-masked',
  'unrecognized-format',
  'already-complete',
  'display-changed',
];

/** What can be printed about a record: the kind, the id and the ALREADY-MASKED display value. */
export interface NumberRecord {
  kind: FullNumberKind;
  id: string;
  masked: string;
}

export interface SkippedRecord extends NumberRecord {
  reason: SkipReason;
  detail?: string;
}

/** A row this run will complete; `full` and `normalized` never leave the script or the manifest. */
interface PlannedCompletion extends NumberRecord {
  display: string;
  full: string;
  normalized: string;
}

export interface NumberBackfillReport {
  dryRun: boolean;
  scanned: Record<FullNumberKind, number>;
  completed: NumberRecord[];
  skipped: SkippedRecord[];
  rollbackFile: string | null;
}

export interface NumberBackfillCliOptions {
  help: boolean;
  dryRun: boolean;
  rollbackFile: string | null;
}

/** One row of the rollback manifest: the value this script wrote into the full-number column. */
export interface RollbackChange {
  kind: FullNumberKind;
  id: string;
  fullNumber: string;
  previousDisplay: string;
}

export interface RollbackResult {
  file: string;
  restored: number;
  unmatched: number;
}

/** Parse the non-interactive CLI surface; anything unknown is a hard usage error. */
export function parseNumberBackfillArguments(args: readonly string[]): NumberBackfillCliOptions {
  const options: NumberBackfillCliOptions = { help: false, dryRun: false, rollbackFile: null };
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
    throw new Error(`Unsupported number backfill argument: ${flag}`);
  }
  if (options.rollbackFile !== null && options.dryRun) {
    throw new Error('--dry-run cannot be combined with --rollback.');
  }
  return options;
}

export function formatUsage(): string {
  return [
    'Usage: pnpm tsx scripts/number-backfill.ts [--dry-run | --rollback=<applied.json>]',
    '',
    '  (no flag)      complete the full-number columns, then write a rollback manifest under logs/number-backfill/',
    '  --dry-run      print the planned completions without writing to the database',
    '  --rollback=<f> clear the values recorded in a manifest written by an earlier real run',
    '  --help         print this usage text',
    '',
    'Only rows with an empty phoneFull / numberFull are scanned, and a row is completed ONLY when its',
    'display column is itself a complete number (copy, never a derivation). Masked display values are',
    'reported as unrecoverable-masked and are never expanded into a guessed number.',
    '',
  ].join('\n');
}

/** A display value is complete, masked (no digits can be recovered) or something else entirely. */
type DisplayShape = 'complete' | 'masked' | 'unrecognized';

function classifyDisplay(value: string, complete: RegExp): DisplayShape {
  if (complete.test(value)) return 'complete';
  if (value.includes('*')) return 'masked';
  return 'unrecognized';
}

/** How an incomplete row is reported when it cannot be completed. Never echoes a full number. */
function skipDetail(shape: DisplayShape): string {
  return shape === 'masked'
    ? 'masked display value: the missing digits cannot be recovered and are never guessed'
    : 'display value is neither a complete number nor a masked form';
}

/** Scan every contact whose `phoneFull` is still empty. Only scalar columns are read. */
async function collectContacts(prisma: PrismaClient): Promise<Array<{ id: string; phone: string }>> {
  return prisma.contact.findMany({
    where: { phoneFull: null },
    select: { id: true, phone: true },
    orderBy: { id: 'asc' },
  });
}

/** Scan every card whose `numberFull` is still empty. Only scalar columns are read. */
async function collectCards(prisma: PrismaClient): Promise<Array<{ id: string; numberMasked: string }>> {
  return prisma.card.findMany({
    where: { numberFull: null },
    select: { id: true, numberMasked: true },
    orderBy: { id: 'asc' },
  });
}

/**
 * Plan the contact completions. A complete `phone` is copied into `phoneFull` and normalized to the
 * masked shape; a masked or unrecognized value is reported and left exactly as it is.
 */
function planContacts(rows: ReadonlyArray<{ id: string; phone: string }>): { planned: PlannedCompletion[]; skipped: SkippedRecord[] } {
  const planned: PlannedCompletion[] = [];
  const skipped: SkippedRecord[] = [];
  for (const row of rows) {
    const shape = classifyDisplay(row.phone, COMPLETE_PHONE);
    const masked = maskPhone(row.phone);
    if (shape !== 'complete') {
      skipped.push({ kind: 'contact-phone', id: row.id, masked, reason: shape === 'masked' ? 'unrecoverable-masked' : 'unrecognized-format', detail: skipDetail(shape) });
      continue;
    }
    planned.push({ kind: 'contact-phone', id: row.id, masked, display: row.phone, full: row.phone, normalized: maskPhone(row.phone) });
  }
  return { planned, skipped };
}

/** Plan the card completions with the same copy-only rule. */
function planCards(rows: ReadonlyArray<{ id: string; numberMasked: string }>): { planned: PlannedCompletion[]; skipped: SkippedRecord[] } {
  const planned: PlannedCompletion[] = [];
  const skipped: SkippedRecord[] = [];
  for (const row of rows) {
    const shape = classifyDisplay(row.numberMasked, COMPLETE_CARD_NUMBER);
    const masked = maskCardNumber(row.numberMasked);
    if (shape !== 'complete') {
      skipped.push({ kind: 'card-number', id: row.id, masked, reason: shape === 'masked' ? 'unrecoverable-masked' : 'unrecognized-format', detail: skipDetail(shape) });
      continue;
    }
    planned.push({ kind: 'card-number', id: row.id, masked, display: row.numberMasked, full: row.numberMasked, normalized: maskCardNumber(row.numberMasked) });
  }
  return { planned, skipped };
}

/**
 * Compare-and-set one planned completion: the full-number column must still be empty AND the display
 * value must still hold the scanned value, so a concurrent binder or a manual edit wins.
 */
async function applyCompletion(prisma: PrismaClient, plan: PlannedCompletion): Promise<SkippedRecord | null> {
  if (plan.kind === 'contact-phone') {
    const { count } = await prisma.contact.updateMany({
      where: { id: plan.id, phoneFull: null, phone: plan.display },
      data: { phoneFull: plan.full, phone: plan.normalized },
    });
    if (count === 0) return classifyRace(prisma, plan);
    return null;
  }
  const { count } = await prisma.card.updateMany({
    where: { id: plan.id, numberFull: null, numberMasked: plan.display },
    data: { numberFull: plan.full, numberMasked: plan.normalized },
  });
  if (count === 0) return classifyRace(prisma, plan);
  return null;
}

/** Explain a lost compare-and-set honestly: the column is filled, or the display value moved. */
async function classifyRace(prisma: PrismaClient, plan: PlannedCompletion): Promise<SkippedRecord> {
  let filled: boolean;
  if (plan.kind === 'contact-phone') {
    const row = await prisma.contact.findUnique({ where: { id: plan.id }, select: { phoneFull: true } });
    filled = row !== null && row.phoneFull !== null;
  } else {
    const row = await prisma.card.findUnique({ where: { id: plan.id }, select: { numberFull: true } });
    filled = row !== null && row.numberFull !== null;
  }
  return {
    kind: plan.kind,
    id: plan.id,
    masked: plan.masked,
    reason: filled ? 'already-complete' : 'display-changed',
    detail: filled
      ? 'another writer filled the full-number column first'
      : 'the display value changed after it was scanned',
  };
}

/** Write the replayable rollback manifest; a real run creates the directory recursively. */
function writeRollbackManifest(planned: readonly PlannedCompletion[], appliedAt: string): string {
  mkdirSync(ROLLBACK_DIRECTORY, { recursive: true });
  const stamp = appliedAt.replace(/[:.]/g, '-');
  const file = path.join(ROLLBACK_DIRECTORY, `${stamp}-applied.json`);
  const changes: RollbackChange[] = planned.map(plan => ({
    kind: plan.kind,
    id: plan.id,
    fullNumber: plan.full,
    previousDisplay: plan.display,
  }));
  writeFileSync(file, `${JSON.stringify({ appliedAt, changes }, null, 2)}\n`, 'utf8');
  // Forward slashes keep the printed rollback command usable in every shell.
  return file.split(path.sep).join('/');
}

/** Scan, plan and (unless dry-run) apply the backfill. */
export async function runNumberBackfill(prisma: PrismaClient, dryRun: boolean): Promise<NumberBackfillReport> {
  const [contacts, cards] = await Promise.all([collectContacts(prisma), collectCards(prisma)]);
  const contactPlan = planContacts(contacts);
  const cardPlan = planCards(cards);
  const planned = [...contactPlan.planned, ...cardPlan.planned];
  const skipped = [...contactPlan.skipped, ...cardPlan.skipped];
  const scanned: Record<FullNumberKind, number> = { 'contact-phone': contacts.length, 'card-number': cards.length };
  if (dryRun) {
    return { dryRun: true, scanned, completed: planned.map(toNumberRecord), skipped, rollbackFile: null };
  }
  const completed: PlannedCompletion[] = [];
  for (const plan of planned) {
    const lost = await applyCompletion(prisma, plan);
    if (lost === null) completed.push(plan);
    else skipped.push(lost);
  }
  const rollbackFile = completed.length > 0 ? writeRollbackManifest(completed, new Date().toISOString()) : null;
  return { dryRun: false, scanned, completed: completed.map(toNumberRecord), skipped, rollbackFile };
}

/** Drop everything but the printable (masked) projection of a planned completion. */
function toNumberRecord(plan: PlannedCompletion): NumberRecord {
  return { kind: plan.kind, id: plan.id, masked: plan.masked };
}

export function formatBackfillSummary(report: NumberBackfillReport): string {
  const lines: string[] = [];
  lines.push('Full-number backfill');
  lines.push(report.dryRun ? 'mode: DRY RUN (nothing is written)' : 'mode: APPLY');
  for (const kind of KINDS) lines.push(`scanned ${kind}: ${report.scanned[kind]} row(s) with an empty full-number column`);
  lines.push(`${report.dryRun ? 'would complete' : 'completed'}: ${report.completed.length}`);
  for (const record of report.completed) lines.push(`  ${record.kind} ${record.id} (${record.masked})`);
  lines.push(`skipped / not completed: ${report.skipped.length}`);
  for (const reason of SKIP_REASONS) {
    const entries = report.skipped.filter(entry => entry.reason === reason);
    if (entries.length === 0) continue;
    lines.push(`  ${reason}: ${entries.length}`);
    for (const entry of entries) lines.push(`    ${entry.kind} ${entry.id} (${entry.masked})${entry.detail ? ` — ${entry.detail}` : ''}`);
  }
  if (report.rollbackFile) {
    lines.push(`rollback file: ${report.rollbackFile}`);
    lines.push(`rollback command: pnpm tsx scripts/number-backfill.ts --rollback=${report.rollbackFile}`);
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
    const { kind, id, fullNumber, previousDisplay } = change;
    if (typeof kind !== 'string' || !KINDS.includes(kind as FullNumberKind)) {
      throw new Error(`Rollback file ${filePath}: changes[${index}].kind must be one of ${KINDS.join(', ')}.`);
    }
    if (typeof id !== 'string' || id === '') throw new Error(`Rollback file ${filePath}: changes[${index}].id is missing.`);
    if (typeof fullNumber !== 'string' || fullNumber === '') {
      throw new Error(`Rollback file ${filePath}: changes[${index}].fullNumber is missing.`);
    }
    if (previousDisplay !== undefined && typeof previousDisplay !== 'string') {
      throw new Error(`Rollback file ${filePath}: changes[${index}].previousDisplay must be a string when present.`);
    }
    return { kind: kind as FullNumberKind, id, fullNumber, previousDisplay: previousDisplay ?? '' };
  });
}

/**
 * Clear the recorded full number only while the row still holds the value this script wrote, so a
 * later manual edit is never overwritten by a stale manifest.
 */
export async function rollbackFullNumbers(prisma: PrismaClient, filePath: string): Promise<RollbackResult> {
  const changes = parseRollbackManifest(filePath);
  let restored = 0;
  let unmatched = 0;
  for (const change of changes) {
    const { count } = change.kind === 'contact-phone'
      ? await prisma.contact.updateMany({ where: { id: change.id, phoneFull: change.fullNumber }, data: { phoneFull: null } })
      : await prisma.card.updateMany({ where: { id: change.id, numberFull: change.fullNumber }, data: { numberFull: null } });
    if (count > 0) restored += 1;
    else unmatched += 1;
  }
  return { file: filePath, restored, unmatched };
}

export function formatRollbackSummary(result: RollbackResult): string {
  return [
    'Full-number backfill rollback',
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
export async function runNumberBackfillCommand(args = process.argv.slice(2)): Promise<void> {
  const options = parseNumberBackfillArguments(args);
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
      process.stdout.write(formatRollbackSummary(await rollbackFullNumbers(prisma, options.rollbackFile)));
      return;
    }
    process.stdout.write(formatBackfillSummary(await runNumberBackfill(prisma, options.dryRun)));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runNumberBackfillCommand().catch(error => {
    process.stderr.write(`Full-number backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
