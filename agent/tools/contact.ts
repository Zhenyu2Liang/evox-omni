/**
 * contact — `search_contact`
 *
 * Contact lookup returns recipient candidates. The runner returns a typed SDK result; the
 * factory uses the shared result adapter to expose complete public model data and Pi errors.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type { ContactView } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import type { ToolExecutionResult } from './index';
import { toModelToolResult, toolFailure } from './result';

/** `search_contact` params — free-text name/phone query. */
export const SearchContactParams = Type.Object({
  query: Type.String({ maxLength: 256, description: 'Contact name or phone fragment. An empty query lists all owned contacts. Search results are candidates, not consent to transfer.' }),
}, { additionalProperties: false });
export type SearchContactArgs = Static<typeof SearchContactParams>;

/** Factory: build the `search_contact` AgentTool bound to `userId` (🟢 GREEN). */
export function createSearchContactTool(userId: string): AgentTool<typeof SearchContactParams> {
  return {
    name: 'search_contact',
    label: '搜索联系人',
    description: 'Search owned contacts by name or phone fragment. Returned entries are masked recipient candidates, not executable transfer authorization. Choose and validate the exact owned contact identity before a transfer.',
    parameters: SearchContactParams,
    execute: async (_toolCallId, params) => toModelToolResult(await runSearchContact(userId, { query: params.query })),
  };
}

/** Model-free runner — `banking.contact.searchContacts(userId, query)`. */
export async function runSearchContact(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    if (typeof args.query !== 'string') throw new AppError('VALIDATION', 'Contact search requires an explicit text query.');
    const query = args.query;
    const contacts = await banking.contact.searchContacts(userId, query);
    return { ok: true, data: contacts, summary: summarizeContacts(query, contacts) };
  } catch (e) {
    return toolFailure(e);
  }
}

/** Concise Chinese summary of a contact search (the text the model narrates). */
function summarizeContacts(query: string, contacts: ContactView[]): string {
  const label = query.trim() === '' ? '全部' : `“${query}”`;
  if (contacts.length === 0) {
    return `未找到匹配${label}的联系人。`;
  }
  const head = contacts
    .slice(0, 5)
    .map((contact) => `${contact.name}（${contact.phone}${contact.bank !== undefined ? `，${contact.bank}` : ''}）`)
    .join('、');
  const extra = contacts.length > 5 ? `，另有 ${contacts.length - 5} 位` : '';
  return `找到 ${contacts.length} 位匹配${label}的联系人：${head}${extra}。`;
}
