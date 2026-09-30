'use client';

import type { ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

/** Join truthy class names without pulling in an extra dependency. */
function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const TAB_BASE_CLASSES =
  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:text-banking-navy disabled:cursor-not-allowed disabled:opacity-50';

const TAB_ACTIVE_CLASSES = 'border-banking-accent font-semibold text-banking-navy';

const TAB_INACTIVE_CLASSES = 'text-gray-500 hover:text-banking-navy';

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 border-b border-banking-light', className)}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={cn(
              TAB_BASE_CLASSES,
              isActive ? TAB_ACTIVE_CLASSES : TAB_INACTIVE_CLASSES,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
