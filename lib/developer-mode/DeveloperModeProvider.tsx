'use client';

import { createContext, useContext, useMemo, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { DEVELOPER_MODE_COOKIE, DEVELOPER_MODE_ENABLED } from '@/lib/developer-mode/shared';

export interface DeveloperModeValue {
  enabled: boolean;
  pending: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const DeveloperModeContext = createContext<DeveloperModeValue>({
  enabled: false,
  pending: false,
  setEnabled: () => undefined,
});

export function DeveloperModeProvider({ initialEnabled, children }: { initialEnabled: boolean; children: ReactNode }) {
  const [enabled, updateEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const value = useMemo<DeveloperModeValue>(() => ({
    enabled,
    pending,
    setEnabled: (nextEnabled) => {
      if (nextEnabled === enabled) return;
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${DEVELOPER_MODE_COOKIE}=${nextEnabled ? DEVELOPER_MODE_ENABLED : '0'}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      updateEnabled(nextEnabled);
      startTransition(() => {
        if (!nextEnabled && ['/runs', '/manual', '/audit'].some(route => pathname === route || pathname.startsWith(`${route}/`))) {
          router.replace('/agent');
        }
        router.refresh();
      });
    },
  }), [enabled, pending, pathname, router]);
  return <DeveloperModeContext.Provider value={value}>{children}</DeveloperModeContext.Provider>;
}

export function useDeveloperMode() {
  return useContext(DeveloperModeContext);
}
