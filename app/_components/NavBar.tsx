'use client';

/**
 * NavBar — global top navigation for the AI Banking Agent demo.
 *
 * Client Component (needs `usePathname()` for active-route highlighting). Rendered
 * once from `app/layout.tsx` so every page is reachable without typing a URL.
 *
 * Active detection: exact match for `/`; prefix match for the rest, so nested routes
 * (e.g. `/agent/foo`) still highlight their section.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  href: string;
  label: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: '总览' },
  { href: '/agent', label: 'AI 助手' },
  { href: '/bills', label: '账单' },
  { href: '/cards', label: '卡片' },
  { href: '/subscriptions', label: '订阅' },
  { href: '/security', label: '安全中心' },
  { href: '/audit', label: '审计日志' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-white/10 bg-banking-deep text-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-6 py-2">
        <Link
          href="/"
          className="mr-4 flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-semibold tracking-tight hover:bg-white/10"
        >
          <span aria-hidden className="text-base">🏦</span>
          <span>
            AI 银行助手
            <span className="ml-2 hidden text-xs font-normal text-white/60 sm:inline">
              AI Banking Agent
            </span>
          </span>
        </Link>

        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-xl bg-banking-accent px-3 py-2 text-sm font-medium text-white'
                  : 'rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white'
              }
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
