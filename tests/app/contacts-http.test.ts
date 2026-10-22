import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/contacts/route';
import { DELETE } from '@/app/api/contacts/[id]/route';
import { auditStore } from '@/audit/audit-logger';
import { banking } from '@/banking-sdk';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { getJson, idCtx, postJson } from './harness';

interface ContactBody { data: { contact: { id: string; name: string; phone: string } } }
const input = { name: 'Ada Example', phone: '13812345678', bank: 'Demo Bank', remark: 'Project team' };

/** An 11-digit complete mainland mobile number anywhere in a serialized payload. */
const COMPLETE_PHONE_IN_TEXT = /\b1[3-9]\d{9}\b/;

async function deleteContact(id: string, body: unknown = { confirm: true }) {
  return DELETE(new NextRequest(`http://localhost/api/contacts/${id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), idCtx(id));
}

describe('Contact management HTTP boundary', () => {
  useFreshDatabase();
  afterEach(() => { vi.restoreAllMocks(); });

  it('saves a resolvable recipient, returns masked views and atomically audits both mutations', async () => {
    const saved = await postJson<ContactBody>(POST, '/api/contacts', input);
    expect(saved.status).toBe(201);
    const contact = saved.data!.data.contact;
    expect(contact.phone).toBe('138****5678');
    // The complete number is kept SERVER-SIDE only (it is what recipient identity matches on)...
    expect((await getTestPrisma().contact.findUnique({ where: { id: contact.id } }))?.phoneFull).toBe(input.phone);
    // ...and never reaches a response body.
    expect(JSON.stringify(saved.data)).not.toMatch(COMPLETE_PHONE_IN_TEXT);
    expect(await banking.contact.searchContacts(DEMO_USER_ID, input.phone)).toEqual([expect.objectContaining({ id: contact.id, phone: '138****5678' })]);
    const list = await getJson<{ data: { contacts: unknown[] } }>(GET, '/api/contacts?userId=other');
    expect(list.data?.data.contacts).toContainEqual(expect.objectContaining({ id: contact.id }));
    expect(JSON.stringify(list.data)).not.toMatch(COMPLETE_PHONE_IN_TEXT);
    expect((await deleteContact(contact.id)).status).toBe(200);
    const db = getTestPrisma();
    expect(await db.contact.findUnique({ where: { id: contact.id } })).toBeNull();
    const entries = await db.auditLog.findMany({ orderBy: { timestamp: 'asc' } });
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.toolName)).toEqual(['add_contact', 'delete_contact']);
    expect(entries.every(entry => entry.userId === DEMO_USER_ID && entry.sessionId === `demo:${DEMO_USER_ID}` && entry.confirmed && !entry.mfaRequired)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(input.phone);
  });

  it('rejects duplicate recipients, malformed fields and browser-selected ownership', async () => {
    expect((await postJson(POST, '/api/contacts', input)).status).toBe(201);
    expect((await postJson(POST, '/api/contacts', { ...input, name: 'Different name' })).status).toBe(409);
    for (const changed of [{ name: ' ' }, { phone: '138****5678' }, { phone: '-13812345678' }, { userId: 'other' }, { name: 'a\nb' }]) {
      expect((await postJson(POST, '/api/contacts', { ...input, ...changed })).status).toBe(400);
    }
    expect(await getTestPrisma().auditLog.count()).toBe(1);
  });

  it('requires an explicit delete decision and never deletes another owner contact', async () => {
    const db = getTestPrisma();
    await db.user.create({ data: { id: 'other-user', name: 'Other User', phone: '13712345678' } });
    await db.contact.create({ data: { id: 'other-contact', userId: 'other-user', name: 'Other Contact', phone: '13712345679' } });
    const saved = await postJson<ContactBody>(POST, '/api/contacts', input);
    const id = saved.data!.data.contact.id;
    expect((await deleteContact(id, {})).status).toBe(400);
    expect((await deleteContact('other-contact')).status).toBe(404);
    expect(await db.contact.findUnique({ where: { id: 'other-contact' } })).not.toBeNull();
    expect((await deleteContact(id)).status).toBe(200);
    expect((await deleteContact(id)).status).toBe(404);
    expect(await db.auditLog.count({ where: { toolName: 'delete_contact' } })).toBe(1);
  });

  it('serializes parallel duplicate submissions without duplicate contacts or audit rows', async () => {
    const responses = await Promise.all([
      postJson(POST, '/api/contacts', input),
      postJson(POST, '/api/contacts', { ...input, name: 'Other Name' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(await getTestPrisma().contact.count({ where: { userId: DEMO_USER_ID, phone: input.phone } })).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { toolName: 'add_contact' } })).toBe(1);
  });

  it('rolls contact changes back if their audit cannot be committed', async () => {
    const spy = vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValue(new Error('Audit unavailable'));
    expect((await postJson(POST, '/api/contacts', input)).status).toBe(500);
    expect(await getTestPrisma().contact.findFirst({ where: { userId: DEMO_USER_ID, phone: input.phone } })).toBeNull();
    spy.mockRestore();
    const saved = await postJson<ContactBody>(POST, '/api/contacts', input);
    const id = saved.data!.data.contact.id;
    vi.spyOn(auditStore, 'insertAuditLog').mockRejectedValue(new Error('Audit unavailable'));
    expect((await deleteContact(id)).status).toBe(500);
    expect(await getTestPrisma().contact.findUnique({ where: { id } })).not.toBeNull();
  });
});
