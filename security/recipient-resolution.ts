/**
 * Transfer-recipient resolution — SERVER-SIDE, performed at PARK time.
 *
 * `transfer_money` is the only tool that carries a free-form recipient selector supplied by the
 * model. To guarantee the confirmation card names the SAME contact the Banking SDK will resolve at
 * execution, the recipient is resolved here (in code, never from model text) BEFORE the action is
 * persisted: the persisted + executed args are then CANONICALIZED to the resolved `contactId`
 * (`canonicalizeTransferArgs`), so the card and `banking-sdk/transfer.ts#resolveRecipient` AGREE.
 *
 * Resolution is TOLERANT of the value/slot the model supplies. A model that echoes whatever
 * `search_contact` returned may put a NAME into `contactId`, a MASKED phone into `contactId`, or a
 * DE-MASKED phone into `phone`; all of those still resolve. It accepts ONE OR MORE selectors and
 * matches EVERY supplied value against every one of the caller's contacts' identity facets
 * (`id`, `name`, MASK-AWARE phone). The union is:
 *   - EXACTLY ONE distinct contact  → `resolved`;
 *   - ZERO                            → `not_found`;
 *   - MORE THAN ONE distinct contact → `ambiguous` (covers a 重名 AND contradictory selectors).
 * It is a pure function of the validated args and the caller's OWN contacts (owner isolation: only
 * the caller's contacts are ever considered, so a foreign/unknown id can never resolve or leak).
 * It NEVER throws — every outcome is reported so the caller can ask the user to clarify.
 */
import type { Contact } from '@prisma/client';
import { getAccount } from '../lib/db/repositories/account';
import { listContacts } from '../lib/db/repositories/contact';
import { maskAwarePhoneMatch, maskPhone } from '../lib/phone';

// Re-exported so the established import surface (`./recipient-resolution`, and transitively
// `./security-gateway`) keeps working for existing callers and tests unchanged.
export { maskAwarePhoneMatch, maskPhone };

/** The recipient selector slots a `transfer_money` call may carry. */
type SelectorKind = 'contactId' | 'phone' | 'name';

/**
 * Result of a SERVER-SIDE transfer-recipient resolution performed at park time. `resolved` names the
 * exact contact the SDK will resolve at execution; every other status is a clarification request
 * (nothing is parked). `kind`/`supplied` describe the FIRST supplied selector so the clarify
 * messages stay stable.
 */
export type RecipientResolution =
  | { status: 'resolved'; contact: { id: string; name: string; phone: string } }
  | { status: 'not_found'; kind: SelectorKind; supplied: string }
  | {
      status: 'ambiguous';
      kind: SelectorKind;
      supplied: string;
      candidates: Array<{ name: string; phone: string }>;
    }
  | { status: 'invalid'; detail: string };

/** A non-empty string counts as a supplied recipient field (mirrors the SDK's `suppliedRecipientFields`). */
function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A contact matches a selector value iff its id, name or mask-aware phone matches. */
function contactMatchesSelector(contact: Contact, value: string): boolean {
  if (contact.id === value) return true;
  if (contact.name === value) return true;
  return maskAwarePhoneMatch(value, contact.phone);
}

/**
 * Resolve the transfer recipient SERVER-SIDE at park time. Accepts ONE OR MORE of
 * `contactId` | `phone` | `name` (a completely absent recipient is `invalid`), loads the caller's
 * contacts ONCE, matches every supplied value against every contact's identity facets (`id`, `name`,
 * mask-aware `phone`), and unions the candidates (deduped by contact id). Never throws.
 */
export async function resolveTransferRecipient(
  userId: string,
  args: Record<string, unknown>,
): Promise<RecipientResolution> {
  const keys = (['contactId', 'phone', 'name'] as const).filter((key) => isPresent(args[key]));
  if (keys.length === 0) {
    return {
      status: 'invalid',
      detail: 'at least one of contactId|phone|name must be supplied (received: 0)',
    };
  }
  const kind = keys[0];
  const supplied = args[kind] as string;

  // Owner isolation for free: only the caller's OWN contacts are ever considered.
  const contacts = await listContacts(userId);
  const matched = new Map<string, Contact>();
  for (const key of keys) {
    const value = args[key] as string;
    for (const contact of contacts) {
      if (contactMatchesSelector(contact, value)) matched.set(contact.id, contact);
    }
  }

  const candidates = [...matched.values()];
  if (candidates.length === 0) return { status: 'not_found', kind, supplied };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      kind,
      supplied,
      candidates: candidates.map((c) => ({ name: c.name, phone: c.phone })),
    };
  }
  const contact = candidates[0];
  return { status: 'resolved', contact: { id: contact.id, name: contact.name, phone: contact.phone } };
}

/**
 * Express a transfer's recipient ONLY via the resolved `contactId`, DELETING `phone` / `name`: the SDK
 * requires EXACTLY ONE recipient field, so keeping the original selector would make execution throw
 * `VALIDATION`. `amount`, `remark` and `sourceAccountId` are preserved EXACTLY.
 */
export function canonicalizeTransferArgs(
  args: Record<string, unknown>,
  contactId: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args, contactId };
  delete next.phone;
  delete next.name;
  return next;
}

/**
 * Label for the funding account on the confirmation card: the real account name when `sourceAccountId`
 * names one of the caller's OWN accounts, else `undefined` (so the caller falls back to the default
 * label). Never throws — an unknown/foreign id simply yields no label.
 */
export async function resolveAccountLabel(
  userId: string,
  sourceAccountId: string | undefined,
): Promise<string | undefined> {
  if (typeof sourceAccountId !== 'string' || sourceAccountId === '') return undefined;
  const account = await getAccount(sourceAccountId);
  if (!account || account.userId !== userId) return undefined;
  return account.name;
}

/**
 * Model-readable Chinese clarification for an unresolvable/ambiguous transfer recipient. Code-free and
 * phone-masked (a raw phone is never emitted). The agent's `beforeToolCall` returns this verbatim so
 * the model asks the user to clarify instead of parking an operation.
 */
export function buildRecipientClarifyMessage(
  res: Exclude<RecipientResolution, { status: 'resolved' }>,
): string {
  if (res.status === 'not_found') {
    return `未能找到与「${res.supplied}」匹配的收款联系人，请向用户确认收款人的姓名或手机号后再试。`;
  }
  if (res.status === 'ambiguous') {
    const candidates = res.candidates.map((c) => `${c.name}（${maskPhone(c.phone)}）`).join('、');
    return `「${res.supplied}」匹配到多个联系人（${candidates}），请向用户确认具体收款人（提供联系人全名或手机号）。`;
  }
  return '请提供且仅提供一个收款人标识（联系人 id、手机号或姓名）后重试。';
}
