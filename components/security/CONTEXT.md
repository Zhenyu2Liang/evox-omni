# components/security — Security & permission visualisations

## Intent

Presentational components that make the **code-enforced permission model visible**: the 🟢/🟡/🔴 tier
legend, the security-event feed, and the circuit-breaker status. Display-only — the actual decisions
are made in `./security` (server); these merely render their outcomes. Server-safe (no hooks).

## API Surface

All named exports, re-exported from `./index.ts`. `SecurityEvent` from `@/lib/contracts/audit`,
`RiskLevel` from `@/lib/contracts/risk`.

```ts
// PermissionLegend.tsx — static explanation of the three tiers (🟢 auto / 🟡 confirm / 🔴 MFA)
export interface PermissionLegendProps { className?: string; }
export function PermissionLegend(p: PermissionLegendProps): JSX.Element;  // Server-safe, no props needed

// SecurityEventList.tsx — feed of SecurityEvent rows (kind, severity, message, time)
export interface SecurityEventListProps { events: SecurityEvent[]; emptyText?: ReactNode;
  className?: string; }
export function SecurityEventList(p: SecurityEventListProps): JSX.Element; // Server-safe

// CircuitBreakerStatus.tsx — breaker state (tripped / failure count vs max MFA attempts)
export interface CircuitBreakerStatusProps { tripped: boolean; failureCount?: number;
  maxAttempts?: number; className?: string; }
export function CircuitBreakerStatus(p: CircuitBreakerStatusProps): JSX.Element; // Server-safe
```

## Constraints

- **Display-only**: never computes a tier or decides permission; renders tiers/events it is given.
- **Tier styling** comes from `ui/StatusBadge` / `lib/constants.RISK_LABEL`; severity colours from the
  Tailwind `banking` palette (`danger`/`warn`/`success`). No hard-coded hex.
- **Server-safe** (no `'use client'`, no hooks/handlers).
- Named exports only; one concern per file.

## Test Strategy

- RTL render tests under the root `tests/` suite: `PermissionLegend` shows all three tiers;
  `SecurityEventList` renders an empty state for `[]`; `CircuitBreakerStatus` reflects `tripped`.

## Routing Table

- `./PermissionLegend.tsx` `./SecurityEventList.tsx` `./CircuitBreakerStatus.tsx` → the visualisations above
- `./index.ts` → re-exports all security components
- `../../app/security/` → security-center page renders these (sibling — read-only)
- `../../lib/contracts/audit.ts` → `SecurityEvent`/`SecurityEventKind` type source (dependency — read-only)
