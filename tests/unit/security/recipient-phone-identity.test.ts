/**
 * Unit (DB-backed): the RECIPIENT phone chain — exact identity, mask candidate, clarification,
 * cross-owner isolation and no full-number leakage.
 *
 * Rules under test (park-time `security/recipient-resolution.ts`, mirrored by
 * `banking-sdk/transfer.ts` at execution):
 *   - a COMPLETE number identifies only the contact whose stored complete number is identical, so
 *     the middle four digits always take part: prefix+suffix collisions never resolve to each other;
 *   - a MASKED number only narrows: 0 → `not_found`, exactly 1 → `resolved` (candidate
 *     uniquification, NOT equality), more → `ambiguous` listing MASKED candidates;
 *   - a history row that kept only a mask (`phoneFull` NULL) can never be identified by a complete
 *     number — "looks like" is not "is";
 *   - only the caller's OWN contacts are considered, and no projection or clarify message ever
 *     contains an 11-digit complete number.
 *
 * The extra colliding contacts are created IN THE TEST via Prisma (`tests/helpers/fixtures.ts` is
 * shared with other suites and stays untouched).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maskPhone } from '@/lib/phone';
import {
  buildRecipientClarifyMessage,
  resolveTransferRecipient,
} from '@/security/recipient-resolution';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** 张伟 — the seeded recipient whose full number is `13900000002` (display `139****0002`). */
const ZHANGWEI_ID = 'contact_zhangwei';
const ZHANGWEI_FULL = '13900000002';
/** 李华 — the only seeded contact on the `135…` visible ends (used for the unique-mask case). */
const LIHUA_ID = 'contact_lihua';
const LIHUA_MASK = '135****0005';
/** A complete number that shares 张伟's prefix 3 + suffix 4 but differs in the middle digits. */
const COLLIDING_FULL = '13911110002';
/** The foreign owner's contact — the caller must never see it. */
const FOREIGN_USER_ID = 'user_foreign';
const FOREIGN_CONTACT_ID = 'contact_foreign';
const FOREIGN_FULL = '13900007777';

/** An 11-digit complete mainland mobile number anywhere in a payload. */
const COMPLETE_PHONE_IN_TEXT = /\b1[3-9]\d{9}\b/;

/** Add a contact that shares 张伟's visible ends but whose middle digits differ. */
async function addCollidingContact(id: string, name: string, full: string): Promise<void> {
  await getTestPrisma().contact.create({
    data: { id, userId: DEMO_USER_ID, name, phone: maskPhone(full), phoneFull: full, bank: '招商银行' },
  });
}

/** Resolve as the demo user (the ONLY caller identity these tests exercise). */
function resolve(args: Record<string, unknown>) {
  return resolveTransferRecipient(DEMO_USER_ID, args);
}

describe('recipient phone identity — complete numbers must match exactly', () => {
  it('resolves 张伟 from the complete number 13900000002', async () => {
    const res = await resolve({ phone: ZHANGWEI_FULL });

    expect(res).toEqual({ status: 'resolved', contact: { id: ZHANGWEI_ID, name: '张伟', phone: maskPhone(ZHANGWEI_FULL) } });
    // The resolved projection is the MASKED display value; `phoneFull` never leaves storage.
    expect(JSON.stringify(res)).not.toMatch(COMPLETE_PHONE_IN_TEXT);
  });

  it('resolves the colliding-middle number to the ONE contact that owns it (never ambiguous)', async () => {
    await addCollidingContact('contact_collide_a', '张伟同事', COLLIDING_FULL);
    await addCollidingContact('contact_collide_b', '张伟邻居', '13999990002');

    // Prefix 139 + suffix 0002 is shared by three contacts, but the complete number is unique.
    const res = await resolve({ phone: COLLIDING_FULL });

    expect(res).toEqual({ status: 'resolved', contact: { id: 'contact_collide_a', name: '张伟同事', phone: '139****0002' } });
  });

  it('does NOT resolve a complete number that only shares the visible ends (13922220002)', async () => {
    await addCollidingContact('contact_collide_a', '张伟同事', COLLIDING_FULL);

    expect(await resolve({ phone: '13922220002' })).toEqual({ status: 'not_found', kind: 'phone', supplied: '13922220002' });
  });

  it('keeps a complete number for a history row (phoneFull NULL) unmatched — a mask is not an identity', async () => {
    const db = getTestPrisma();
    await db.contact.create({
      data: { id: 'contact_history', userId: DEMO_USER_ID, name: '历史联系人', phone: '139****8888', phoneFull: null },
    });

    // "Looks like" is not "is": the middle digits of `13900008888` are unverifiable.
    expect(await resolve({ phone: '13900008888' })).toEqual({ status: 'not_found', kind: 'phone', supplied: '13900008888' });

    // The same history row is still reachable as the UNIQUE candidate of its own mask.
    expect(await resolve({ phone: '139****8888' })).toMatchObject({ status: 'resolved', contact: { id: 'contact_history' } });
  });
});

describe('recipient phone candidate — a mask narrows, it does not identify', () => {
  it('resolves a masked number ONLY as the unique candidate of the caller\'s contacts', async () => {
    // Sole contact on these visible ends ⇒ candidate uniquification (not number equality).
    const res = await resolve({ phone: LIHUA_MASK });

    expect(res).toEqual({ status: 'resolved', contact: { id: LIHUA_ID, name: '李华', phone: LIHUA_MASK } });
  });

  it('reports a colliding mask as ambiguous, listing MASKED candidates and leaking no full number', async () => {
    await addCollidingContact('contact_collide_a', '张伟同事', COLLIDING_FULL);
    await addCollidingContact('contact_collide_b', '张伟邻居', '13999990002');

    const res = await resolve({ phone: '139****0002' });

    expect(res).toMatchObject({ status: 'ambiguous', kind: 'phone', supplied: '139****0002' });
    if (res.status !== 'ambiguous') throw new Error('expected an ambiguous resolution');
    expect(res.candidates.map((c) => c.name).sort()).toEqual(['张伟', '张伟同事', '张伟邻居'].sort());
    expect(res.candidates.every((c) => c.phone === '139****0002')).toBe(true);

    const message = buildRecipientClarifyMessage(res);
    expect(message).toContain('匹配到多个联系人');
    expect(message).toContain('****');
    expect(message).not.toMatch(COMPLETE_PHONE_IN_TEXT);
  });

  it('a complete number is NOT downgraded to a mask candidate when it matches nobody', async () => {
    await addCollidingContact('contact_collide_a', '张伟同事', COLLIDING_FULL);

    // `13911110002` is owned by one contact; `13933330002` matches no stored complete number, and
    // its visible ends must NOT be used to guess a recipient.
    expect(await resolve({ phone: '13933330002' })).toEqual({ status: 'not_found', kind: 'phone', supplied: '13933330002' });
  });
});

describe('recipient resolution — owner isolation and leakage', () => {
  // `useFreshDatabase()` registers a ROOT beforeEach, so the foreign owner must be re-created in a
  // beforeEach of equal depth (a beforeAll would run before the reset and be wiped).
  beforeEach(async () => {
    const db = getTestPrisma();
    await db.user.create({ data: { id: FOREIGN_USER_ID, name: '外部用户', phone: '137****9999' } });
    await db.contact.create({
      data: {
        id: FOREIGN_CONTACT_ID,
        userId: FOREIGN_USER_ID,
        name: '外部联系人',
        phone: maskPhone(FOREIGN_FULL),
        phoneFull: FOREIGN_FULL,
        bank: '中国银行',
      },
    });
  });

  it('never resolves another owner\'s contact id (not_found, no leak)', async () => {
    const res = await resolve({ contactId: FOREIGN_CONTACT_ID });

    expect(res).toEqual({ status: 'not_found', kind: 'contactId', supplied: FOREIGN_CONTACT_ID });
    expect(JSON.stringify(res)).not.toMatch(COMPLETE_PHONE_IN_TEXT);
    if (res.status !== 'not_found') throw new Error('expected not_found');
    expect(buildRecipientClarifyMessage(res)).not.toContain(FOREIGN_FULL);
  });

  it('never resolves another owner\'s phone, and its number is not echoed back', async () => {
    const res = await resolve({ phone: FOREIGN_FULL });

    // The caller owns nobody with this number ⇒ not_found. The supplied selector is echoed (it is
    // the caller's own input), but no candidate list and no stored full number is disclosed.
    expect(res).toMatchObject({ status: 'not_found', kind: 'phone' });
    expect('candidates' in res).toBe(false);
    if (res.status !== 'not_found') throw new Error('expected not_found');
    expect(buildRecipientClarifyMessage(res)).not.toContain('外部联系人');
  });

  it('keeps another owner\'s CONTACT rows out of the ambiguous candidate list', async () => {
    // Give the foreign owner a mask that collides with 张伟's visible ends: only the caller's own
    // contacts may ever appear as candidates.
    await getTestPrisma().contact.create({
      data: { id: 'contact_foreign_twin', userId: FOREIGN_USER_ID, name: '外部张伟', phone: '139****0002', phoneFull: '13955550002' },
    });

    const res = await resolve({ phone: '139****0002' });

    expect(res).toEqual({ status: 'resolved', contact: { id: ZHANGWEI_ID, name: '张伟', phone: '139****0002' } });
    expect(JSON.stringify(res)).not.toContain('外部张伟');
  });
});
