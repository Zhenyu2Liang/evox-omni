/**
 * Permission Engine — the STATIC half of the security policy.
 *
 * DESIGN PRINCIPLE (LLM-IMMUTABLE): the permission tier of every tool is decided
 * HERE, in TypeScript, from a static policy table plus deterministic dynamic rules
 * (delegated to `./risk-engine`). The model can NEVER influence `tier`,
 * `requiresConfirmation` or `requiresMfa` — it only supplies tool arguments, which
 * are validated independently by each tool. The agent may decide WHAT to do next;
 * it may never decide WHETHER it is allowed.
 *
 * This module also carries the code-enforced notion of "produces a side effect"
 * (`ToolPolicy.write`): AUDITING is decided by that flag, NOT by the permission colour, so a GREEN
 * write is audited exactly like a gated action. The flag grants NOTHING — `tier` alone decides what
 * may execute (see `./security-gateway`).
 *
 * This module performs NO I/O and is fully pure/deterministic.
 */
import type { RiskLevel } from '../lib/contracts/risk';
import type { ToolName } from '../lib/contracts/tools';
import { evaluateTransferRisk } from './risk-engine';
import { AppError } from '../lib/errors';
import { normalizeTransferAmount } from '../lib/money';
import { TOOL_CATALOG, TOOL_NAMES, isCatalogToolName, catalogEntry } from '../lib/contracts/tool-catalog';

export interface ToolPolicy {
  /** Static risk tier for the tool. `transfer_money` is dynamic (see `static: false`). */
  tier: RiskLevel;
  /** `true` when the tier is fixed by the table; `false` when it is computed at runtime. */
  static: boolean;
  /**
   * `true` when the tool PERSISTS a side effect (a write). Side-effecting operations are audited
   * regardless of their permission colour — see `@/agent/write-audit`. This is a metadata fact about
   * the capability, never a permission: the tier still decides whether the call may execute.
   */
  write: boolean;
  /** Human-readable policy note, surfaced in the audit log and UI. */
  description: string;
}

/** Inputs the evaluator needs beyond the raw tool arguments. */
export interface EvaluateToolContext {
  userId: string;
  sessionId: string;
  /** Sum of today's outgoing transfers for `userId` (from `risk-engine.computeDailyTransferTotal`). */
  dailyTransferTotal: import('../lib/money').MoneyInput;
}

export interface ToolEvaluation {
  tier: RiskLevel;
  requiresConfirmation: boolean;
  requiresMfa: boolean;
  reasons: string[];
}

/**
 * The frozen GREEN / YELLOW / RED policy table — the single source of truth for tool tiers.
 * Keys MUST cover every `ToolName`. `transfer_money` is dynamic (`static: false`);
 * `submit_plan` is a planner meta-tool and is NOT risk-gated.
 */
export const TOOL_POLICY: Record<ToolName, ToolPolicy> = Object.fromEntries(TOOL_NAMES.map(name => {
  const entry = TOOL_CATALOG[name];
  return [name, Object.freeze({ tier: entry.defaultTier, static: entry.authorization === 'static',
    write: entry.effect === 'write', description: entry.description })];
})) as Record<ToolName, ToolPolicy>;

/** Look up the static policy for a tool. Throws `AppError('VALIDATION')` for an unknown tool. */
export function getToolPolicy(toolName: ToolName): ToolPolicy {
  if (!isCatalogToolName(toolName)) throw new AppError('VALIDATION', `Unknown banking tool: ${toolName}`);
  const policy = TOOL_POLICY[toolName];
  return policy;
}

/**
 * `true` when the tool persists a side effect and must therefore be AUDITED, whatever its colour.
 * Consumed by the write-audit path (`@/agent/write-audit`); it grants no capability.
 */
export function isWriteTool(toolName: ToolName): boolean {
  return getToolPolicy(toolName).write;
}

/**
 * Fully evaluate a tool call into its effective permission tier and flags.
 *
 * Rules:
 *  - `GREEN` → no confirmation, no MFA.
 *  - `YELLOW` → `requiresConfirmation: true`, no MFA.
 *  - `RED` → `requiresConfirmation: true`, `requiresMfa: true`.
 *  - `transfer_money` (dynamic) → delegates to `evaluateTransferRisk({ amount, dailyTransferTotal })`.
 *  - `submit_plan` → allow (no confirmation/MFA).
 *
 * The returned `tier`/flags depend ONLY on the policy table, the validated `amount`
 * derived from `args`, and `ctx.dailyTransferTotal` — never on model text.
 */
export function evaluateTool(
  toolName: ToolName,
  args: Record<string, unknown>,
  ctx: EvaluateToolContext,
): ToolEvaluation {
  const policy = getToolPolicy(toolName);
  if (catalogEntry(toolName)?.agentEnabled === false) throw new AppError('SECURITY_DENIED', 'Card creation and deletion require the card management page.');

  // Dynamic tools (e.g. transfer_money): tier depends on the amount + day total.
  if (!policy.static) {
    const amount = normalizeTransferAmount(args.amount);
    const r = evaluateTransferRisk({ amount, dailyTransferTotal: ctx.dailyTransferTotal });
    return {
      tier: r.tier,
      requiresConfirmation: r.requiresConfirmation,
      requiresMfa: r.requiresMfa,
      reasons: r.reasons,
    };
  }

  // Static tools: tier is fixed by the policy table.
  const tier = policy.tier;
  return {
    tier,
    requiresConfirmation: tier !== 'GREEN',
    requiresMfa: tier === 'RED',
    reasons: [policy.description],
  };
}
