/** Explicit, operator-reviewed simulation inputs. No missing number or net value is inferred. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { PrismaClient } from '../lib/db/prisma';
import { decimalText } from '../lib/decimal';
import { maskCardNumber, maskPhone } from '../lib/mask';
import { resolveDatabaseFile } from './database-file.mjs';

const text = z.string().min(1);
const owner = { id: text, userId: text, expectedName: text };
const planSchema = z.object({
  purpose: z.literal('FICTIONAL_DEMO_REFERENCE'),
  products: z.array(z.object({ id: text, code: text, expectedName: text,
    netValue: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
    netValueDate: z.iso.datetime({ offset: true }),
  }).strict()).default([]),
  contacts: z.array(z.object({ ...owner, expectedDisplay: text,
    phoneFull: z.string().regex(/^1[3-9]\d{9}$/),
  }).strict()).default([]),
  cards: z.array(z.object({ id: text, userId: text, expectedType: z.enum(['DEBIT', 'CREDIT', 'VIRTUAL']),
    expectedDisplay: text, numberFull: z.string().regex(/^\d{12,19}$/),
  }).strict()).default([]),
}).strict();

interface Change { kind: 'product' | 'contact' | 'card'; id: string }
function conflict(kind: string, id: string): never {
  throw new Error(`Reference does not match ${kind} ${id}; no changes applied.`);
}

/** All matches are checked before writing; a conflict rolls the entire plan back. */
export async function applyReferencePlan(db: PrismaClient, input: unknown, apply = false): Promise<{ planned: Change[]; applied: boolean }> {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid fictional reference plan. Check field names, dates and numeric precision.');
  const plan = parsed.data;
  const keys = [...plan.products.map(p => `p:${p.id}`), ...plan.contacts.map(p => `c:${p.id}`), ...plan.cards.map(p => `k:${p.id}`)];
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate record in reference plan.');
  return db.$transaction(async tx => {
    const planned: Change[] = [];
    for (const p of plan.products) {
      if (decimalText(p.netValue) === '0') conflict('product', p.id);
      const row = await tx.investmentProduct.findUnique({ where: { id: p.id } });
      if (!row || row.code !== p.code || row.name !== p.expectedName) conflict('product', p.id);
      if (row.latestNetValuePerUnit !== null || row.latestNetValueDate !== null) {
        if (row.latestNetValuePerUnit !== decimalText(p.netValue) || row.latestNetValueDate?.getTime() !== new Date(p.netValueDate).getTime()) conflict('product', p.id);
      } else planned.push({ kind: 'product', id: p.id });
    }
    for (const c of plan.contacts) {
      const row = await tx.contact.findUnique({ where: { id: c.id } });
      if (!row || row.userId !== c.userId || row.name !== c.expectedName || row.phone !== c.expectedDisplay ||
          maskPhone(c.phoneFull) !== maskPhone(c.expectedDisplay)) conflict('contact', c.id);
      if (row.phoneFull !== null) {
        if (row.phoneFull !== c.phoneFull) conflict('contact', c.id);
      } else planned.push({ kind: 'contact', id: c.id });
    }
    for (const c of plan.cards) {
      const row = await tx.card.findUnique({ where: { id: c.id } });
      if (!row || row.userId !== c.userId || row.type !== c.expectedType || row.numberMasked !== c.expectedDisplay ||
          c.numberFull.slice(-4) !== c.expectedDisplay.slice(-4)) conflict('card', c.id);
      if (row.numberFull !== null) {
        if (row.numberFull !== c.numberFull) conflict('card', c.id);
      } else planned.push({ kind: 'card', id: c.id });
    }
    if (apply) {
      for (const p of plan.products.filter(p => planned.some(c => c.kind === 'product' && c.id === p.id))) {
        const result = await tx.investmentProduct.updateMany({
          where: { id: p.id, code: p.code, name: p.expectedName, latestNetValuePerUnit: null, latestNetValueDate: null },
          data: { latestNetValuePerUnit: decimalText(p.netValue), latestNetValueDate: new Date(p.netValueDate) },
        });
        if (result.count !== 1) conflict('product', p.id);
      }
      for (const c of plan.contacts.filter(p => planned.some(c => c.kind === 'contact' && c.id === p.id))) {
        const result = await tx.contact.updateMany({
          where: { id: c.id, userId: c.userId, name: c.expectedName, phone: c.expectedDisplay, phoneFull: null },
          data: { phoneFull: c.phoneFull, phone: maskPhone(c.phoneFull) },
        });
        if (result.count !== 1) conflict('contact', c.id);
      }
      for (const c of plan.cards.filter(p => planned.some(c => c.kind === 'card' && c.id === p.id))) {
        const result = await tx.card.updateMany({
          where: { id: c.id, userId: c.userId, type: c.expectedType, numberMasked: c.expectedDisplay, numberFull: null },
          data: { numberFull: c.numberFull, numberMasked: c.expectedDisplay.includes('*') ? c.expectedDisplay : maskCardNumber(c.numberFull) },
        });
        if (result.count !== 1) conflict('card', c.id);
      }
    }
    return { planned, applied: apply };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find(a => a.startsWith('--plan='))?.slice(7);
  if (!file || args.some(a => !a.startsWith('--plan=') && a !== '--apply' && a !== '--dry-run') ||
      (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: pnpm exec tsx scripts/demo-reference-backfill.ts --plan=<json> [--dry-run | --apply]');
  }
  const source = resolveDatabaseFile();
  const { createDatabaseClient } = await import('../lib/db/database');
  const db = createDatabaseClient('file:' + source);
  try {
    const report = await applyReferencePlan(db, JSON.parse(readFileSync(file, 'utf8')), args.includes('--apply'));
    // Never log supplied numbers or environment values. IDs suffice to review the plan.
    console.log(JSON.stringify({ mode: report.applied ? 'apply' : 'dry-run', records: report.planned }));
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error instanceof SyntaxError ? 'Invalid reference JSON.' : error.message);
    process.exitCode = 1;
  });
}
