/**
 * contact.search.test.ts — DB-backed unit spec for the CANDIDATE phone search of
 * `lib/db/repositories/contact#searchContacts`.
 *
 * The seeded `Contact.phone` values are MASKED (e.g. 张伟 `139****0002`) while the complete number
 * lives in the server-only `Contact.phoneFull` (`13900000002`). A search is therefore a CANDIDATE
 * narrowing only (`lib/phone#phoneCandidateMatches`): a hit means "maybe this contact", never "this is
 * the recipient". A caller that acts on money must still establish an IDENTITY (a complete number,
 * a `contactId` or an exact name) or require a UNIQUE candidate — which is why a masked query that
 * collides on the visible ends must return EVERY candidate instead of silently picking one.
 *
 * Lives in the root Vitest test tree (`tests/unit/lib/`) and runs against the REAL test SQLite
 * (`tests/helpers/db` + `tests/helpers/fixtures`), which is reset+seeded before every test
 * (DB-backed).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { searchContacts } from '@/lib/db/repositories/contact';
import { maskPhone } from '@/lib/phone';

/** An 11-digit complete mainland mobile number anywhere in a payload. */
const COMPLETE_PHONE_IN_TEXT = /\b1[3-9]\d{9}\b/;

/** Add a contact that shares 张伟's VISIBLE ends (139…0002) but differs in the middle four digits. */
async function addCollidingContact(id: string, name: string, phoneFull: string): Promise<void> {
  await getTestPrisma().contact.create({
    data: { id, userId: DEMO_USER_ID, name, phone: maskPhone(phoneFull), phoneFull, bank: '招商银行' },
  });
}

describe('searchContacts — candidate phone narrowing & name resolution', () => {
  beforeEach(resetDatabase, 30000);
  afterAll(disconnectTestPrisma, 30000);

  it('narrows to 张伟 from a COMPLETE phone (13900000002) via the server-only full number', async () => {
    const results = await searchContacts(DEMO_USER_ID, '13900000002');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('张伟');
    expect(results[0].phone).toBe('139****0002');
  });

  it('narrows to 张伟 from the MASKED phone (139****0002) — a candidate, not an identity', async () => {
    const results = await searchContacts(DEMO_USER_ID, '139****0002');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('张伟');
  });

  it('returns EVERY colliding candidate for a masked query (uniqueness is the caller\'s job)', async () => {
    await addCollidingContact('contact_collide_a', '张伟同事', '13911110002');
    await addCollidingContact('contact_collide_b', '张伟邻居', '13999990002');

    const masked = await searchContacts(DEMO_USER_ID, '139****0002');
    expect(masked.map((c) => c.name)).toEqual(['张伟', '张伟同事', '张伟邻居']);

    // A COMPLETE query still pins exactly one contact: the middle digits decide.
    const complete = await searchContacts(DEMO_USER_ID, '13911110002');
    expect(complete.map((c) => c.name)).toEqual(['张伟同事']);
  });

  it('resolves 张伟 by name', async () => {
    const results = await searchContacts(DEMO_USER_ID, '张伟');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('张伟');
  });

  it('returns all seeded contacts for an empty keyword', async () => {
    const results = await searchContacts(DEMO_USER_ID, '');

    const seeded = await getTestPrisma().contact.findMany({
      where: { userId: DEMO_USER_ID },
      orderBy: { name: 'asc' },
    });
    expect(results.map((c) => c.name)).toEqual(seeded.map((c) => c.name));
    expect(results.map((c) => c.name)).toEqual(['妈妈', '张伟', '李华', '王芳']);
  });

  it('never exposes the server-only complete number in the returned rows', async () => {
    const [zhangwei] = await searchContacts(DEMO_USER_ID, '13900000002');

    // The row carries `phoneFull` for SERVER-SIDE identity; the public projection (`toContactView`)
    // masks `phone` and drops the full column — asserted end-to-end in `tests/app/contacts-http.test.ts`.
    expect(zhangwei.phone).toBe('139****0002');
    expect(JSON.stringify({ id: zhangwei.id, name: zhangwei.name, phone: zhangwei.phone }))
      .not.toMatch(COMPLETE_PHONE_IN_TEXT);
  });
});
