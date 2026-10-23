/**
 * Transfer-recipient resolution — SERVER-SIDE, performed at PARK time.
 *
 * `transfer_money` is the only tool that carries a free-form recipient selector supplied by the
 * model. To guarantee the confirmation card names the SAME contact the Banking SDK will resolve at
 * execution, the recipient is resolved here (in code, never from model text) BEFORE the action is
 * persisted: the persisted + executed args are then CANONICALIZED to the resolved `contactId`
 * (`canonicalizeTransferArgs`), so the card and `banking-sdk/transfer.ts#resolveRecipient` AGREE.
 *
 * TWO DISTINCT phone questions are asked, in this order (`lib/phone`):
 *   1. IDENTITY (`phoneIdentityMatches`) — a complete number must equal the contact's stored complete
 *      number (`Contact.phoneFull`) character-for-character, so the middle four digits always take
 *      part and a mask can never identify anybody.
 *   2. CANDIDATE (`phoneCandidateMatches`) — a MASKED selector only narrows the caller's contacts by
 *      the visible ends. It never claims number equality; it may resolve ONLY a unique candidate
 *      (the user typed a mask, so a single visible-end match is the best available evidence and the
 *      confirmation card still shows the resolved name + masked number).
 *
 * Each supplied selector matches only its declared field. IDs and names are exact. Every supplied
 * field must match the same contact. Resolution considers only the caller's owned contacts (owner
 * isolation: a foreign/unknown id can never resolve or leak). The outcome is:
 *   - EXACTLY ONE identity match      → `resolved`;
 *   - ZERO with no masked phone       → `not_found`;
 *   - EXACTLY ONE mask candidate      → `resolved` (candidate uniquification, not equality);
 *   - ZERO mask candidates            → `not_found`;
 *   - MORE THAN ONE contact           → `ambiguous` (duplicate names or colliding masks).
 * A history row that kept only a mask (`phoneFull` NULL) can never be identified by a complete
 * number — "looks like" is not "is" — so a complete number for it is `not_found`.
 * Nothing in this module ever emits `Contact.phoneFull`: only `maskPhone`-ed values leave it.
 * It NEVER throws — every outcome is reported so the caller can ask the user to clarify.
 */
import type { Contact } from '@/lib/db/prisma';
import { contactPhoneFacets, listContacts } from '../lib/db/repositories/contact';
import { getAccount } from '../lib/db/repositories/account';
import { isMaskedPhone, maskPhone, phoneCandidateMatches, phoneIdentityMatches } from '../lib/phone';

export { maskPhone };

/** The recipient selector slots a `transfer_money` call may carry. */
type SelectorKind = 'contactId' | 'phone' | 'name';

/** One supplied selector: the field it declares and the value to match on that field alone. */
interface Selection {
  kind: SelectorKind;
  value: string;
}

/**
 * Result of a SERVER-SIDE transfer-recipient resolution performed at park time. `resolved` names the
 * exact contact the SDK will resolve at execution; every other status is a clarification request
 * (nothing is parked). `kind`/`supplied` describe the FIRST supplied selector so the clarify
 * messages stay stable. Every phone value here is already `maskPhone`-ed.
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

/** A selector is matched against its declared IDENTITY field only. */
function matchesIdentity(contact: Contact, selection: Selection): boolean {
  if (selection.kind === 'contactId') return contact.id === selection.value;
  if (selection.kind === 'name') return contact.name === selection.value;
  return phoneIdentityMatches(selection.value, contactPhoneFacets(contact));
}

/** Same field isolation, but the phone slot only NARROWS by visible ends (a candidate, not identity). */
function matchesCandidate(contact: Contact, selection: Selection): boolean {
  if (selection.kind === 'phone') return phoneCandidateMatches(selection.value, contactPhoneFacets(contact));
  return matchesIdentity(contact, selection);
}

/** Public projection of a resolved contact — the phone is masked, `phoneFull` never leaves storage. */
function resolvedContact(contact: Contact): { id: string; name: string; phone: string } {
  return { id: contact.id, name: contact.name, phone: maskPhone(contact.phone) };
}

/** Public projection of unresolvable candidates — masked names/phones only. */
function maskedCandidates(rows: Contact[]): Array<{ name: string; phone: string }> {
  return rows.map((contact) => ({ name: contact.name, phone: maskPhone(contact.phone) }));
}

/**
 * Resolve the transfer recipient SERVER-SIDE at park time. Accepts ONE OR MORE of
 * `contactId` | `phone` | `name` (a completely absent recipient is `invalid`). Every supplied field
 * must match its own facet on the same owned contact. Never throws.
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
  const selections: Selection[] = keys.map((key) => ({ kind: key, value: args[key] as string }));

  // Owner isolation for free: only the caller's OWN contacts are ever considered.
  const contacts = await listContacts(userId);

  // 1. IDENTITY — the only rule that may bind a recipient to a stored phone number.
  const identified = contacts.filter((contact) => selections.every((selection) => matchesIdentity(contact, selection)));
  if (identified.length === 1) return { status: 'resolved', contact: resolvedContact(identified[0]) };
  if (identified.length > 1) {
    return { status: 'ambiguous', kind, supplied, candidates: maskedCandidates(identified) };
  }

  // 2. CANDIDATE — a MASKED selector may narrow to exactly one owned contact. This is candidate
  //    uniquification, NOT number equality: the mask hides the middle digits, so the caller must
  //    confirm the masked recipient that was reported back.
  if (!selections.some((selection) => selection.kind === 'phone' && isMaskedPhone(selection.value))) {
    return { status: 'not_found', kind, supplied };
  }
  const narrowed = contacts.filter((contact) => selections.every((selection) => matchesCandidate(contact, selection)));
  if (narrowed.length === 1) return { status: 'resolved', contact: resolvedContact(narrowed[0]) };
  if (narrowed.length > 1) {
    return { status: 'ambiguous', kind, supplied, candidates: maskedCandidates(narrowed) };
  }
  return { status: 'not_found', kind, supplied };
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
