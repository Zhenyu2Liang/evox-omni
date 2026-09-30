/**
 * security — `change_password`
 *
 * Change the demo user's login password. TypeBox param schema; `execute` is meant to THROW
 * `AppError` on failure. `runChangePassword(userId, args)` is the model-free path used by
 * `executeDirect` (invoked ONLY after the gateway authorizes a RED action): it CATCHES and returns
 * `ToolExecutionResult{ok:false,error}`.
 *
 * Tier: 🔴 RED (requires MFA verification). Tier is decided by `security/`, NOT here.
 *
 * DESIGN NOTE: this is the ONLY registered tool with no `banking-sdk` function — the demo `User`
 * model stores no credential (`prisma/schema.prisma`), and the SDK is an execute-only banking
 * surface. The tool exists to exercise RED gating + MFA + audit; the authoritative record of the
 * change is the `AuditLog` entry written by the gateway/agent, not a persisted credential. The
 * runner therefore returns a simulated success view model rather than writing a banking row.
 *
 * `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/** `change_password` params. */
export const ChangePasswordParams = Type.Object({
  currentPassword: Type.String({ description: '当前密码' }),
  newPassword: Type.String({ minLength: 6, description: '新密码（至少 6 位）' }),
});
export type ChangePasswordArgs = Static<typeof ChangePasswordParams>;

/** Registered AgentTool for `change_password` (🔴 RED). */
export const changePasswordTool: AgentTool<ChangePasswordArgs> = {
  name: 'change_password',
  label: '修改密码',
  description: '修改登录密码（高风险，需要短信验证码验证）。',
  parameters: ChangePasswordParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/**
 * Model-free runner — demo-only: validates `currentPassword`/`newPassword` and returns a success
 * view model. There is no banking-sdk function; the audit entry is authoritative (see file header).
 */
export async function runChangePassword(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}
