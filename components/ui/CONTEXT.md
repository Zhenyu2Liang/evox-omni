# components/ui — Design-system primitives

## Intent

Framework-agnostic, Tailwind-styled **leaf primitives** shared by every other component node.
Lowest common ancestor for visual chrome (surfaces, buttons, badges, money, dialogs, tables) so
no sibling ever re-implements it. No business logic, no data fetching, no contract-specific knowledge.

## API Surface

All names are named exports, re-exported from `./index.ts`.

```ts
// Card.tsx  — rounded surface with soft shadow (rounded-2xl bg-white shadow-xs)
export interface CardProps { title?: ReactNode; description?: ReactNode; footer?: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg'; className?: string; children: ReactNode; }
export function Card(p: CardProps): JSX.Element;                         // Server-safe

// Button.tsx — action button (client: bears onClick)
export interface ButtonProps { variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg'; loading?: boolean; disabled?: boolean;
  type?: 'button' | 'submit'; onClick?: () => void; className?: string; children: ReactNode; }
export function Button(p: ButtonProps): JSX.Element;                     // 'use client'

// Badge.tsx — small pill; tone = semantic colour
export interface BadgeProps { tone?: 'neutral' | 'info' | 'success' | 'warn' | 'danger';
  className?: string; children: ReactNode; }
export function Badge(p: BadgeProps): JSX.Element;                       // Server-safe

// StatusBadge.tsx — permission-tier aware (🟢/🟡/🔴); label defaults to RISK_LABEL[tier]
export interface StatusBadgeProps { tier: RiskLevel; label?: string; className?: string; }
export function StatusBadge(p: StatusBadgeProps): JSX.Element;           // Server-safe

// Money.tsx — renders lib/money.formatCNY(amount); never hand-format money
export interface MoneyProps { amount: number; signed?: boolean; className?: string; }
export function Money(p: MoneyProps): JSX.Element;                       // Server-safe

// Tabs.tsx — controlled tab strip (client)
export interface TabItem { id: string; label: ReactNode; }
export interface TabsProps { tabs: TabItem[]; active: string; onChange: (id: string) => void; className?: string; }
export function Tabs(p: TabsProps): JSX.Element;                         // 'use client'

// Dialog.tsx — inline modal overlay (client; NOT a portal). Closes on overlay click / Escape; no focus-trap, no scroll-lock.
export interface DialogProps { open: boolean; onClose: () => void; title?: ReactNode;
  footer?: ReactNode; className?: string; children: ReactNode; }
export function Dialog(p: DialogProps): JSX.Element;                     // 'use client'

// Spinner.tsx — loading indicator
export interface SpinnerProps { size?: 'sm' | 'md' | 'lg'; className?: string; }
export function Spinner(p: SpinnerProps): JSX.Element;                   // Server-safe

// EmptyState.tsx — zero-data placeholder
export interface EmptyStateProps { title: ReactNode; description?: ReactNode;
  icon?: ReactNode; action?: ReactNode; className?: string; }
export function EmptyState(p: EmptyStateProps): JSX.Element;             // Server-safe

// Table.tsx — generic, column-driven table
export interface TableColumn<T> { key: string; header: ReactNode; align?: 'left' | 'right' | 'center';
  render?: (row: T) => ReactNode; className?: string; }
export interface TableProps<T> { columns: TableColumn<T>[]; rows: T[];
  rowKey: (row: T, index: number) => string; empty?: ReactNode; className?: string; }
export function Table<T>(p: TableProps<T>): JSX.Element;                 // Server-safe
```

## Constraints

- **Client vs Server**: only `Button`, `Tabs`, `Dialog` carry `'use client'` (they need interactivity).
  The rest are Server-safe presentational components (no hooks, no handlers) usable in both contexts.
- **Colours** come only from the Tailwind CSS 4 `--color-banking-*` theme in `app/globals.css`; no ad-hoc hex.
- Use current Tailwind utilities: `shadow-xs` for small surface shadows and `outline-hidden` when a transparent forced-colour focus outline is intended. Native modal dialogs specify `m-auto` to center under the current preflight reset.
- **Tier colours** are owned by `StatusBadge` (via `RiskLevel` + `lib/constants.RISK_LABEL`) — do not
  re-implement tier colouring elsewhere.
- **Money** must go through `Money` (`lib/money.formatCNY`); never `toFixed` amounts inline.
- No imports from `prisma`, `banking-sdk` write fns, or any sibling `components/*` node (this is the
  bottom of the components dependency graph; only `lib` is allowed below it).
- Named exports only; files ≲ ~1000 lines, one primitive per file.

## Test Strategy

- `Money` formatting and `StatusBadge` tier→label mapping are pure and unit-tested under the root
  `tests/` suite with table-driven cases (incl. negatives for `Money`).
- Primitive render tests (RTL) assert classNames/tone tokens; no logic to test beyond mapping.

## Routing Table

- `./Card.tsx` `./Button.tsx` `./Badge.tsx` `./StatusBadge.tsx` `./Money.tsx` `./Tabs.tsx`
  `./Dialog.tsx` `./Spinner.tsx` `./EmptyState.tsx` `./Table.tsx` → the primitives above
- `./index.ts` → re-exports all primitives
- `../chat`, `../charts`, `../banking`, `../security` → consumers of these primitives (siblings — read-only)
