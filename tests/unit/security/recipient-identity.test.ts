/**
 * Unit: security/recipient-resolution — field isolation + identity vs candidate (mocked contact rows).
 *
 * Each supplied selector (`contactId` | `name` | `phone`) matches ONLY its declared field, and every
 * supplied field must point at the same owned contact. The phone slot is split in two:
 *   - a COMPLETE number establishes an identity only by character equality with the stored complete
 *     number (`phoneFull`), middle four digits included;
 *   - a MASKED selector is a CANDIDATE narrowing: visible ends only, never an identity claim, and it
 *     may resolve ONLY a unique candidate.
 * Rows here carry both facets (`phone` display + server-only `phoneFull`), like the real table.
 */
import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => [
  { id: 'contact-one', name: 'Alice', phone: '139****0002', phoneFull: '13900000002' },
  { id: 'contact-two', name: 'Bob', phone: '139****0003', phoneFull: '13900000003' },
  // Same visible ends as `contact-one`, different middle digits: a candidate, never an identity.
  { id: 'contact-three', name: 'Carol', phone: '139****0002', phoneFull: '13911110002' },
]);
// The repository barrel also exports `contactPhoneFacets`, the ONLY way the resolver reads the two
// phone facets, so the mock must mirror it (identity would otherwise see no complete number at all).
vi.mock('@/lib/db/repositories/contact', () => ({
  listContacts: vi.fn(async () => rows),
  contactPhoneFacets: (row: { phone: string; phoneFull?: string | null }) => ({
    full: row.phoneFull ?? null,
    display: row.phone,
  }),
}));
vi.mock('@/lib/db/repositories/account', () => ({ getAccount: vi.fn() }));

import { resolveTransferRecipient } from '@/security/recipient-resolution';

describe('recipient identity fields', () => {
  it.each([{ contactId: 'contact-one' }, { name: 'Alice' }, { phone: '13900000002' }])('binds the declared identity field %j', async args => {
    expect(await resolveTransferRecipient('owner', args)).toMatchObject({ status: 'resolved', contact: { id: 'contact-one' } });
  });

  it.each([{ contactId: 'Alice' }, { name: 'contact-one' }, { phone: '0002' }, { phone: 'Alice' }])('rejects cross-field and partial aliases %j', async args => {
    expect(await resolveTransferRecipient('owner', args)).toMatchObject({ status: 'not_found' });
  });

  it('requires every supplied identity field to refer to the same saved contact', async () => {
    expect(await resolveTransferRecipient('owner', { contactId: 'unknown', name: 'Alice' })).toMatchObject({ status: 'not_found' });
    expect(await resolveTransferRecipient('owner', { contactId: 'contact-one', name: 'Bob' })).toMatchObject({ status: 'not_found' });
    expect(await resolveTransferRecipient('owner', { contactId: 'contact-one', name: 'Alice' })).toMatchObject({ status: 'resolved', contact: { id: 'contact-one' } });
  });
});

describe('recipient phone identity vs candidate', () => {
  it('binds the complete number of the colliding-middle contact exactly (no mask collision)', async () => {
    expect(await resolveTransferRecipient('owner', { phone: '13911110002' }))
      .toMatchObject({ status: 'resolved', contact: { id: 'contact-three' } });
  });

  it('does NOT bind a complete number whose middle four digits differ from every stored number', async () => {
    expect(await resolveTransferRecipient('owner', { phone: '13999990002' }))
      .toMatchObject({ status: 'not_found' });
  });

  it('reports a colliding masked selector as ambiguous and masks every candidate', async () => {
    const res = await resolveTransferRecipient('owner', { phone: '139****0002' });

    expect(res).toMatchObject({ status: 'ambiguous', kind: 'phone', supplied: '139****0002' });
    if (res.status !== 'ambiguous') throw new Error('expected ambiguous');
    expect(res.candidates.map((c) => c.name).sort()).toEqual(['Alice', 'Carol']);
    expect(res.candidates.every((c) => c.phone === '139****0002')).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/\b1[3-9]\d{9}\b/);
  });
});
