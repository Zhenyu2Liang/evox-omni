/**
 * security — `change_password`
 *
 * Change the demo user's login password. TypeBox param schema; `execute` THROWS
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
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import type { ToolExecutionResult } from './index';

/** `change_password` params. */
export const ChangePasswordParams = Type.Object({});
export type ChangePasswordArgs = Static<typeof ChangePasswordParams>;

/** Registered AgentTool for `change_password` (🔴 RED). */
export function createChangePasswordTool(userId: string): AgentTool<typeof ChangePasswordParams> {
  return {
    name: 'change_password',
    label: '修改密码',
    description: '演示修改密码的强验证流程；不接收真实密码，不改变真实凭证。直接用空参数调用，再由用户在界面验证。',
    parameters: ChangePasswordParams,
    execute: async (_toolCallId, params) => {
      const result = await runChangePassword(userId, params as Record<string, unknown>);
      if (!result.ok) throw new AppError('TOOL_FAILED', result.error ?? 'change_password failed');
      return {
        content: [{ type: 'text', text: result.summary ?? '操作成功' }],
        details: result.data,
      };
    },
  };
}

/**
 * Model-free runner — demo-only: validates `currentPassword`/`newPassword` and returns a success
 * view model. There is no banking-sdk function; the audit entry is authoritative (see file header).
 */
export async function runChangePassword(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const currentPassword = args.currentPassword ?? '[演示凭证]';
    const newPassword = args.newPassword ?? '[演示凭证]';
    if (typeof currentPassword !== 'string' || currentPassword === '') {
      throw new AppError('VALIDATION', 'change_password 需要 currentPassword');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new AppError('VALIDATION', 'change_password 的新密码至少需要 6 位');
    }
    const data = { changed: true, userId, changedAt: demoNow() };
    return {
      ok: true,
      data,
      summary: '登录密码已修改（演示环境未持久化凭证，变更以审计日志为准）。',
    };
  } catch (e) {
    return { ok: false, error: AppError.from(e).message };
  }
}
