# audit — Audit Log Page (`/audit`)

## Intent

The **audit-log screen**: the tabular accountability trail of the agent loop — one row per tool-call
decision and gated execution, showing the 风控/验证 outcome (risk tier, confirmation required/confirmed,
MFA required/result, tool result, status). It is the evidence for the demo's security claims.

This node is a **thin Server Component** — it fetches the audit read models directly on the server
(no HTTP hop) and composes the UI from `../components`.

## API Surface

- **Page route**: `/audit` — `page.tsx`, default-exported Server Component.
- **Read models** (server-only, via `@/audit`):
  - `audit.listAudit({ sessionId, limit })` → `AuditEntry[]` (newest-first)
  - `audit.getAuditSummary()` → `AuditSummary` (`{ total, byRisk, byStatus }`)
  - Session id: the `banking_session` cookie (`SESSION_COOKIE`).
- **Composes** (from `@/components` — read-only): `ui/Table` for the audit trail with columns
  timestamp / userRequest / intent / toolName / riskLevel / confirmationRequired / confirmed /
  mfaRequired / mfaResult / toolResult / status; `ui/Card` as the surface; `ui/EmptyState` for the
  zero-row case; summary badges from `ui/Badge` (total + one per `AuditStatus`) and `ui/StatusBadge`
  (one per `RiskLevel`, labelled from `RISK_LABEL`).

## Display mappings (page-local, presentation only)

- `STATUS_VIEW: Record<AuditStatus, { label; tone }>` — Chinese label + badge tone per audit status.
- `MFA_RESULT_LABEL` — `success`/`failed`/`not_required` → 验证通过 / 验证失败 / 无需验证 (an absent
  `mfaResult` renders as 无需验证; the MFA code itself is never rendered).
- `summarizeToolResult(unknown)` — one-line JSON view of `toolResult`, truncated to 120 chars (`—` for
  an absent result).
- Timestamps render through `@/lib/date.formatDateTime` on the server (`timestamp` is epoch ms; no
  `Date` object crosses a boundary).

## Constraints

- **Server Component**; no UI logic beyond the display mappings above.
- Pass only **serializable** props to client components (no `Date` — epoch ms; render timestamps as
  epoch ms and format client-side).
- **Read via `@/audit` only** — never import Prisma directly.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- **Never redeclare** the frozen `AuditEntry` type — import it from `@/lib/contracts/audit`.
- The MFA code must never be surfaced in the UI.
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/audit` (sibling — read-only): `listAudit`, `getAuditSummary`; type `AuditSummary`.
- `@/lib/contracts/audit` (sibling — read-only): `AuditEntry`, `AuditStatus`.
- `@/lib/constants` (sibling — read-only): `SESSION_COOKIE`.
- `next/headers` — read the `banking_session` cookie for the session id.
- `../components` (sibling — read-only): the audit table + summary badges.
- `../api` (sibling — read-only): `GET /api/audit` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/audit` page (audit table + summary badges)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/audit` refresh endpoint (sibling — read-only)
