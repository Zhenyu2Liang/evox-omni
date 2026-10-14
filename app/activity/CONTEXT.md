# activity — Business operation history (`/activity`)

## Purpose

Ordinary users inspect the progress and outcome of banking operations here. This is read-only
event history; older pending labels describe the state at that event's timestamp, not a current
approval inbox. Confirmation and verification remain on each original operation card.

## Data

- Dynamic `page.tsx` resolves the fixed demo owner and session via `requireIdentity()`.
- Read `listOperationHistory({ userId, sessionId })` from the audit facade.
- `ActivityRecord` in `lib/contracts/activity.ts` contains an internal row key, timestamp, closed
  operation type, status and verification outcome. It excludes tool names, arguments, results and prompts.
- `/api/activity` provides the same public projection. Projection and grouping belong to the backend.
- Own-transaction acknowledgement is a business action and appears as `transaction_acknowledgement`.
  Exclude technical reads and developer maintenance, not this user confirmation event.

## Presentation

`ActivityHistory.tsx` renders operation names, status badges, business-zone timestamps and verification
labels through the bilingual catalog. Records stack on narrow screens.
The internal record ID is a React key only and never appears as a DOM attribute or visible text.
Do not add direct confirmation controls, workflow retry links or raw audit fields here.
Detailed execution diagnostics remain on the independently gated developer page `/audit`.

## Verification

- `tests/unit/lib/activity-presentation.test.ts`: unsafe properties do not render; the server page uses only the scoped projection.
- `tests/e2e/activity.e2e-helper.ts`: public API shape, ordinary navigation, reload persistence and 320 px layout.
- `tests/e2e/card-freeze.e2e-helper.ts`: both independently verified freezes appear as completed business operations.
