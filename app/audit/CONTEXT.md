# audit — Developer audit page (`/audit`)

## Intent

The technical audit trail records tool decisions, authorization and execution evidence.
Ordinary business history lives at `/activity`; this page belongs to the developer navigation group.

This dynamic Server Component checks `getServerDeveloperMode()` before resolving identity or loading
audit records. When disabled, render only `DeveloperModeRequired` with `titleKey="app.audit"`.
Audit data must not enter HTML or RSC output. `/api/audit` independently checks the same preference.
Disabling developer mode while on `/audit` returns to `/agent`.

## API Surface

- **Page route**: `/audit` — `page.tsx`, default-exported Server Component.
- **Read models** (server-only, via `@/audit`):
  - `audit.listAudit({ sessionId, userId, limit })` → `AuditEntry[]` (newest-first)
  - `audit.getAuditSummary({ sessionId, userId })` → `AuditSummary` (`{ total, byRisk, byStatus }`)
  - Identity: the configured demo user and fixed workspace from `requireIdentity`, without login.
- **Composes** (from `@/components` — read-only): `ui/Table` for the audit trail with columns
  timestamp / userRequest / intent / toolName / riskLevel / confirmationRequired / confirmed /
  mfaRequired / mfaResult / toolResult / expandable technical details / status; `ui/Card` as the surface; `ui/EmptyState` for the
  zero-row case; summary badges from `ui/Badge` (total + one per `AuditStatus`) and `ui/StatusBadge`
  (one per `RiskLevel`, labelled from `RISK_LABEL`).

## Display mappings (page-local, presentation only)

- `statusView: Record<AuditStatus, { label; tone }>` — localized label and badge tone per audit status.
- `verificationLabels` — localized verification outcomes; missing required evidence stays unknown.
- Show both localized and raw tool identity. Expandable details include recorded arguments, results,
  error detail and plan/node references. Upstream persistence redacts secrets; never reconstruct MFA codes.
- `summarizeToolResult(unknown)` — one-line JSON view of `toolResult`, truncated to 120 chars (`—` for
  an absent result).
- Timestamps render through `@/lib/date.formatDateTime` on the server (`timestamp` is epoch ms; no
  `Date` object crosses a boundary).

## Constraints

- **Server Component**; no UI logic beyond the display mappings above.
- Keep the server gate before all audit queries. Navigation hiding is insufficient.
- The technical table scrolls in its own container on narrow screens.
- Pass only **serializable** props to client components (no `Date` — epoch ms; the page formats
  timestamps server-side through `@/lib/date.formatDateTime`).
- **Read via `@/audit` only** — never import Prisma directly.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- **Never redeclare** the frozen `AuditEntry` type — import it from `@/lib/contracts/audit`.
- The MFA code must never be surfaced in the UI. Do not pass raw entries to ordinary history components.
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/audit` (sibling — read-only): `listAudit`, `getAuditSummary`; type `AuditSummary`.
- `@/lib/contracts/audit` (sibling — read-only): `AuditEntry`, `AuditStatus`.
- `@/app/api/_lib/session` — fixed demo identity, independent of browser cookies.
- `@/lib/i18n/server` — server localization using the language preference cookie.
- `../components` (sibling — read-only): the audit table + summary badges.
- `../api` (sibling — read-only): `GET /api/audit` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/audit` page (audit table + summary badges)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/audit` refresh endpoint (sibling — read-only)
