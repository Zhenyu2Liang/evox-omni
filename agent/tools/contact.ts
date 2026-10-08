/**
 * contact — `search_contact`
 *
 * Contact lookup (also feeds transfer recipient resolution). TypeBox param schema; `execute` calls
 * the Banking SDK and THROWS `AppError` on failure. `runSearchContact(userId, args)` is the
 * model-free path used by `executeDirect`; it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
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

/** `search_contact` params — free-text name/phone query. */
export const SearchContactParams = Type.Object({
  query: Type.String({ description: '联系人姓名或手机号关键字' }),
});
export type SearchContactArgs = Static<typeof SearchContactParams>;

/** Factory: build the `search_contact` AgentTool bound to `userId` (🟢 GREEN). */
export function createSearchContactTool(userId: string): AgentTool<typeof SearchContactParams> {
  return {
    name: 'search_contact',
    label: '搜索联系人',
    description: '按姓名或手机号模糊搜索当前用户的联系人（用于确定转账收款人）。',
    parameters: SearchContactParams,
    execute: async (_toolCallId, params) => {
      const result = await runSearchContact(userId, { query: params.query });
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'search_contact failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/** Model-free runner — `banking.contact.searchContacts(userId, query)`. */
export async function runSearchContact(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const query = typeof args.query === 'string' ? args.query : '';
    const contacts = await banking.contact.searchContacts(userId, query);
    return { ok: true, data: contacts, summary: summarizeContacts(query, contacts) };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
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
