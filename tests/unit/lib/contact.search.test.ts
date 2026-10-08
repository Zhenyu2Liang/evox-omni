/**
 * contact.search.test.ts — DB-backed unit spec for the MASK-AWARE contact search of
 * `lib/db/repositories/contact#searchContacts`.
 *
 * The seeded `Contact.phone` values are MASKED (e.g. 张伟 `139****0002`) while a transfer
 * recipient is often supplied as a RAW number (`13900000002`), which never substring-matches
 * the masked value in SQL. `searchContacts` therefore loads the caller's contacts and filters
 * in memory by name substring (case-insensitive) OR a mask-aware phone match (`@/lib/phone`),
 * and an empty keyword matches every name (the previous "return all contacts" behaviour).
 *
 * Lives in the root Vitest test tree (`tests/unit/lib/`) and runs against the REAL test SQLite
 * (`tests/helpers/db` + `tests/helpers/fixtures`), which is reset+seeded before every test
 * (DB-backed).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { searchContacts } from '@/lib/db/repositories/contact';

describe('searchContacts — mask-aware phone & name resolution', () => {
  beforeEach(resetDatabase, 30000);
  afterAll(disconnectTestPrisma, 30000);

  it('resolves 张伟 from a RAW phone (13900000002) against the MASKED stored value', async () => {
    const results = await searchContacts(DEMO_USER_ID, '13900000002');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('张伟');
    expect(results[0].phone).toBe('139****0002');
  });

  it('resolves 张伟 from the MASKED phone (139****0002)', async () => {
    const results = await searchContacts(DEMO_USER_ID, '139****0002');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('张伟');
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
});
