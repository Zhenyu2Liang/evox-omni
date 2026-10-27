/**
 * scripts/number-backfill.ts — completing the server-only full-number columns (`Contact.phoneFull`,
 * `Card.numberFull`) without ever guessing a number.
 *
 * The behaviour under test is the safety contract of the upgrade:
 *   - COMPLETE display values are COPIED into the new column and the display column is normalized
 *     through `lib/mask.ts` (so the existing masked projection keeps rendering the same value);
 *   - a MASKED display value (`138****8000`, `****8821`) is reported as `unrecoverable-masked` and its
 *     full-number column stays NULL — the missing digits are never invented;
 *   - a row that already holds a full number is never scanned, so a user-created record survives
 *     untouched;
 *   - writes are compare-and-set, so a repeated run completes nothing (idempotent) and data is stable;
 *   - `--dry-run` writes nothing, a real run leaves a rollback manifest, and `--rollback` clears only
 *     rows that still hold the value this script wrote (a later manual edit is never overwritten);
 *   - the printed report only exposes masked values.
 *
 * DB-backed: `useFreshDatabase()` resets + seeds the shared `prisma/test.db` per test. The seeded
 * fixtures already carry their full numbers, so every incomplete row here is created explicitly.
 */
import { describe, expect, it } from 'vitest';

import {
  formatBackfillSummary,
  parseNumberBackfillArguments,
  parseRollbackManifest,
  rollbackFullNumbers,
  runNumberBackfill,
} from '../../../scripts/number-backfill';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const db = () => getTestPrisma();

/** A complete (unmasked) fake mobile number; its masked form is `138****8000`. */
const FULL_PHONE = '13800008000';
const MASKED_PHONE = '138****8000';
/** A complete (unmasked) fake card number; `maskCardNumber` keeps only the last four characters. */
const FULL_CARD = '6222000000004321';
const MASKED_CARD = '************4321';

/** An already-masked contact phone: no digits may be recovered from it. */
const UNRECOVERABLE_PHONE = '138****8000';
/** An already-masked card number: no digits may be recovered from it. */
const UNRECOVERABLE_CARD = '****8821';

/** Insert a contact whose full-number column is still empty, exactly like a legacy row. */
async function createLegacyContact(id: string, phone: string, phoneFull: string | null = null): Promise<void> {
  await db().contact.create({ data: { id, userId: DEMO_USER_ID, name: `联系人 ${id}`, phone, phoneFull, bank: null, remark: null } });
}

/** Insert a card whose full-number column is still empty, exactly like a legacy row. */
async function createLegacyCard(id: string, numberMasked: string, numberFull: string | null = null): Promise<void> {
  await db().card.create({
    data: { id, userId: DEMO_USER_ID, type: 'VIRTUAL', network: 'UnionPay', numberMasked, numberFull, status: 'ACTIVE' },
  });
}

describe('runNumberBackfill — copies complete values, never derives masked ones', () => {
  it('copies a complete phone/card number and normalizes the display column with lib/mask', async () => {
    await createLegacyContact('contact_complete', FULL_PHONE);
    await createLegacyCard('card_complete', FULL_CARD);

    const report = await runNumberBackfill(db(), true);
    // Dry run: the plan is reported, the database is untouched.
    expect(report.dryRun).toBe(true);
    expect(report.rollbackFile).toBeNull();
    expect((await db().contact.findUnique({ where: { id: 'contact_complete' } }))?.phoneFull).toBeNull();
    expect((await db().card.findUnique({ where: { id: 'card_complete' } }))?.numberFull).toBeNull();

    const applied = await runNumberBackfill(db(), false);
    expect(applied.completed).toEqual([
      { kind: 'contact-phone', id: 'contact_complete', masked: MASKED_PHONE },
      { kind: 'card-number', id: 'card_complete', masked: MASKED_CARD },
    ]);
    expect(applied.skipped).toEqual([]);

    const contact = await db().contact.findUnique({ where: { id: 'contact_complete' } });
    expect(contact?.phoneFull).toBe(FULL_PHONE);
    expect(contact?.phone).toBe(MASKED_PHONE);

    const card = await db().card.findUnique({ where: { id: 'card_complete' } });
    expect(card?.numberFull).toBe(FULL_CARD);
    expect(card?.numberMasked).toBe(MASKED_CARD);
    expect(applied.rollbackFile).not.toBeNull();
  });

  it('is idempotent: a second run completes nothing and leaves the data identical', async () => {
    await createLegacyContact('contact_complete', FULL_PHONE);
    await createLegacyCard('card_complete', FULL_CARD);

    await runNumberBackfill(db(), false);
    const before = {
      contact: await db().contact.findUnique({ where: { id: 'contact_complete' } }),
      card: await db().card.findUnique({ where: { id: 'card_complete' } }),
    };

    const second = await runNumberBackfill(db(), false);
    expect(second.completed).toEqual([]);
    expect(second.rollbackFile).toBeNull();
    expect(await db().contact.findUnique({ where: { id: 'contact_complete' } })).toEqual(before.contact);
    expect(await db().card.findUnique({ where: { id: 'card_complete' } })).toEqual(before.card);
  });

  it('reports masked display values as unrecoverable and leaves the full-number column NULL', async () => {
    await createLegacyContact('contact_masked', UNRECOVERABLE_PHONE);
    await createLegacyCard('card_masked', UNRECOVERABLE_CARD);

    const report = await runNumberBackfill(db(), false);

    expect(report.completed).toEqual([]);
    expect(report.rollbackFile).toBeNull();
    expect(report.skipped).toEqual([
      {
        kind: 'contact-phone',
        id: 'contact_masked',
        masked: MASKED_PHONE,
        reason: 'unrecoverable-masked',
        detail: expect.stringContaining('never guessed'),
      },
      {
        kind: 'card-number',
        id: 'card_masked',
        masked: UNRECOVERABLE_CARD,
        reason: 'unrecoverable-masked',
        detail: expect.stringContaining('never guessed'),
      },
    ]);

    const contact = await db().contact.findUnique({ where: { id: 'contact_masked' } });
    expect(contact?.phoneFull).toBeNull();
    // The masked display value is left EXACTLY as scanned — it is never rewritten into a guess.
    expect(contact?.phone).toBe(UNRECOVERABLE_PHONE);
    const card = await db().card.findUnique({ where: { id: 'card_masked' } });
    expect(card?.numberFull).toBeNull();
    expect(card?.numberMasked).toBe(UNRECOVERABLE_CARD);
  });

  it('never rewrites a row that already holds a full number (user-created records survive)', async () => {
    const USER_PHONE_FULL = '13711112222';
    const USER_CARD_FULL = '6222000000009999';
    await createLegacyContact('contact_user', '137****2222', USER_PHONE_FULL);
    await createLegacyCard('card_user', '************9999', USER_CARD_FULL);
    // The seeded demo contacts/cards already carry their full numbers too.
    await createLegacyContact('contact_complete', FULL_PHONE);

    const report = await runNumberBackfill(db(), false);

    // Only the genuinely incomplete row is scanned and completed.
    expect(report.completed).toEqual([{ kind: 'contact-phone', id: 'contact_complete', masked: MASKED_PHONE }]);
    expect(report.skipped).toEqual([]);

    const userContact = await db().contact.findUnique({ where: { id: 'contact_user' } });
    expect(userContact?.phoneFull).toBe(USER_PHONE_FULL);
    expect(userContact?.phone).toBe('137****2222');
    const userCard = await db().card.findUnique({ where: { id: 'card_user' } });
    expect(userCard?.numberFull).toBe(USER_CARD_FULL);
    expect(userCard?.numberMasked).toBe('************9999');

    // Seeded fixture rows keep their (fictional, 0000-range) full numbers and masked display values.
    const seeded = await db().contact.findUnique({ where: { id: 'contact_zhangwei' } });
    expect(seeded?.phoneFull).toBe('13900000002');
    expect(seeded?.phone).toBe('139****0002');
  });

  it('rolls back only the rows that still hold the value it wrote', async () => {
    await createLegacyContact('contact_complete', FULL_PHONE);
    await createLegacyCard('card_complete', FULL_CARD);

    const report = await runNumberBackfill(db(), false);
    const rollbackFile = report.rollbackFile;
    expect(rollbackFile).not.toBeNull();

    // The manifest records exactly what was written, per record.
    const manifest = parseRollbackManifest(rollbackFile as string);
    expect(manifest).toEqual([
      { kind: 'contact-phone', id: 'contact_complete', fullNumber: FULL_PHONE, previousDisplay: FULL_PHONE },
      { kind: 'card-number', id: 'card_complete', fullNumber: FULL_CARD, previousDisplay: FULL_CARD },
    ]);

    // A later manual edit wins: the rollback must not overwrite it.
    await db().contact.update({ where: { id: 'contact_complete' }, data: { phoneFull: '13922223333' } });

    const result = await rollbackFullNumbers(db(), rollbackFile as string);
    expect(result).toMatchObject({ restored: 1, unmatched: 1 });

    expect((await db().contact.findUnique({ where: { id: 'contact_complete' } }))?.phoneFull).toBe('13922223333');
    expect((await db().card.findUnique({ where: { id: 'card_complete' } }))?.numberFull).toBeNull();
  });

  it('prints only masked values in its report', async () => {
    await createLegacyContact('contact_complete', FULL_PHONE);
    await createLegacyCard('card_complete', FULL_CARD);
    await createLegacyContact('contact_masked', UNRECOVERABLE_PHONE);

    const summary = formatBackfillSummary(await runNumberBackfill(db(), true));
    expect(summary).not.toContain(FULL_PHONE);
    expect(summary).not.toContain(FULL_CARD);
    expect(summary).toContain(`contact-phone contact_complete (${MASKED_PHONE})`);
    expect(summary).toContain('unrecoverable-masked: 1');
  });
});

describe('parseNumberBackfillArguments — the CLI surface is strict', () => {
  it('accepts the documented flags', () => {
    expect(parseNumberBackfillArguments([])).toEqual({ help: false, dryRun: false, rollbackFile: null });
    expect(parseNumberBackfillArguments(['--dry-run'])).toMatchObject({ dryRun: true });
    expect(parseNumberBackfillArguments(['--rollback=logs/number-backfill/x-applied.json'])).toMatchObject({
      rollbackFile: 'logs/number-backfill/x-applied.json',
    });
    expect(parseNumberBackfillArguments(['--rollback', 'logs/number-backfill/x-applied.json'])).toMatchObject({
      rollbackFile: 'logs/number-backfill/x-applied.json',
    });
  });

  it('rejects unknown flags and an empty rollback path', () => {
    expect(() => parseNumberBackfillArguments(['--force'])).toThrow(/Unsupported number backfill argument/);
    expect(() => parseNumberBackfillArguments(['--rollback='])).toThrow(/requires the path/);
    expect(() => parseNumberBackfillArguments(['--dry-run', '--rollback=x.json'])).toThrow(/cannot be combined/);
  });
});
