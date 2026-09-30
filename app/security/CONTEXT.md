# security — Security Center Page (`/security`)

## Intent

The **security centre screen**: the visible face of the code-enforced permission model — the
🟢/🟡/🔴 tier legend, the session's recent verifications, the circuit-breaker status, and the
`SecurityEvent` stream (injection attempts, MFA failures, breaker trips, blocked high-risk ops).
It demonstrates that permission is decided by `../security`, not by the model.

This node is a **thin Server Component** — it fetches the security read models directly on the
server (no HTTP hop) and composes the UI from `../components`.

## API Surface

- **Page route**: `/security` — `page.tsx`, default-exported Server Component.
- **Read models** (server-only, via `@/audit`):
  - `audit.getSecurityStatus(sessionId)` → `SecurityStatus` (`{ locked, recentEvents }`)
  - `audit.listSecurityEvents({ sessionId })` → `SecurityEvent[]`
  - Session id: the `banking_session` cookie (`SESSION_COOKIE`).
- **Composes** (from `../components` — referenced by name only): the `RISK_LABEL` legend
  (🟢/🟡/🔴), recent verifications, circuit-breaker status, and the `SecurityEvents` table.

## Constraints

- **Server Component**; render chrome + `TODO: wire read model` comments — no security logic here.
  The circuit-breaker lock state is authoritative in `../security`; this page only displays it.
- Pass only **serializable** props to client components (no `Date` — epoch ms).
- **Read via `@/audit` only** — never import Prisma directly, never import `../security` internals.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- Status renders via `RISK_LABEL` from `@/lib/constants` (🟢/🟡/🔴).
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/audit` (sibling — read-only): `getSecurityStatus`, `listSecurityEvents`; types `SecurityStatus`.
- `@/lib/contracts/audit` (sibling — read-only): `SecurityEvent`, `SecurityEventKind`.
- `@/lib/contracts/risk` + `@/lib/constants` (sibling — read-only): `RiskLevel`, `RISK_LABEL`, `SESSION_COOKIE`.
- `next/headers` — read the `banking_session` cookie for the session id.
- `../components` (sibling — read-only): legend, verification list, breaker status, events table.
- `../api` (sibling — read-only): `GET /api/security` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/security` page (legend, verifications, breaker, security events)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/security` refresh endpoint (sibling — read-only)
