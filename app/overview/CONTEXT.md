# Asset overview route

## Purpose

`/overview` is the asset dashboard. The home route redirects to `/agent`; this route owns the
former dashboard composition and is linked under the sidebar's Banking group.

## Data and boundaries

The page is a Server Component with `dynamic = 'force-dynamic'`. It reads
`banking.dashboard.getDashboardSummary(getConfig().demoUserId)` directly on each request.
It composes `AssetSummaryCard`, the optional display-only `AnomalyBanner`, and
`RecentTransactions`. No banking mutation, financial arithmetic, permission decision, or browser
transport belongs here. Displayed balances come from the read model; the page creates no estimates.

## Navigation

The assistant link opens `/agent`. Global navigation and mobile-menu behavior are owned by
`app/_components/AppShell.tsx`; the page uses ordinary document scrolling.
