/**
 * contact — `search_contact`
 *
 * Contact lookup (also feeds transfer recipient resolution). TypeBox param schema; `execute` is
 * meant to call the Banking SDK and THROW `AppError` on failure. `runSearchContact(userId, args)`
 * is the model-free path used by `executeDirect`; it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🟢 GREEN (read-only).
 * No permission/risk/MFA logic here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `search_contact` params — free-text name/phone query. */
export const SearchContactParams = Type.Object({
  query: Type.String({ description: '联系人姓名或手机号关键字' }),
});
export type SearchContactArgs = Static<typeof SearchContactParams>;

/** Registered AgentTool for `search_contact` (🟢 GREEN). */
export const searchContactTool: AgentTool<SearchContactArgs> = {
  name: 'search_contact',
  label: '搜索联系人',
  description: '按姓名或手机号模糊搜索当前用户的联系人（用于确定转账收款人）。',
  parameters: SearchContactParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.contact.searchContacts(userId, query)`. */
export async function runSearchContact(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}
