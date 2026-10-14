import type { MessageKey, Translator } from '@/lib/i18n/shared';

export type NavigationIconName =
  | 'assistant'
  | 'contacts'
  | 'investments'
  | 'schedule'
  | 'review'
  | 'overview'
  | 'bills'
  | 'cards'
  | 'subscriptions'
  | 'runs'
  | 'audit'
  | 'security';

interface NavigationItem {
  href: string;
  labelKey: MessageKey;
  icon: NavigationIconName;
}

interface NavigationGroup {
  labelKey: MessageKey;
  items: readonly NavigationItem[];
  developerOnly?: boolean;
}

export const NAVIGATION_GROUPS: readonly NavigationGroup[] = [
  {
    labelKey: 'app.groupAssistant',
    items: [
      { href: '/agent', labelKey: 'app.assistant', icon: 'assistant' },
      { href: '/schedules', labelKey: 'app.schedules', icon: 'schedule' },
    ],
  },
  {
    labelKey: 'app.groupBanking',
    items: [
      { href: '/overview', labelKey: 'app.overview', icon: 'overview' },
      { href: '/bills', labelKey: 'app.bills', icon: 'bills' },
      { href: '/cards', labelKey: 'app.cards', icon: 'cards' },
      { href: '/contacts', labelKey: 'app.contacts', icon: 'contacts' },
      { href: '/investments', labelKey: 'app.investments', icon: 'investments' },
      { href: '/subscriptions', labelKey: 'app.subscriptions', icon: 'subscriptions' },
    ],
  },
  {
    labelKey: 'app.groupActivity',
    items: [
      { href: '/activity', labelKey: 'app.activity', icon: 'audit' },
      { href: '/security', labelKey: 'app.security', icon: 'security' },
    ],
  },
  {
    labelKey: 'app.groupDeveloper',
    developerOnly: true,
    items: [
      { href: '/runs', labelKey: 'app.runs', icon: 'runs' },
      { href: '/audit', labelKey: 'app.audit', icon: 'audit' },
      { href: '/manual', labelKey: 'app.manual', icon: 'review' },
    ],
  },
];

export function getNavigationGroups(developerMode: boolean): readonly NavigationGroup[] {
  return NAVIGATION_GROUPS.filter(group => developerMode || !group.developerOnly);
}

export function isNavigationActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function getNavigationTitle(pathname: string, t: Translator): string {
  const item = NAVIGATION_GROUPS.flatMap((group) => group.items).find((item) =>
    isNavigationActive(pathname, item.href),
  );
  return t(item?.labelKey ?? 'app.brand');
}
