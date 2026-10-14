import { describe, expect, it } from 'vitest';
import { isDeveloperModeEnabled } from '@/lib/developer-mode/shared';
import { getNavigationGroups } from '@/app/_components/navigation';

describe('developer workspace preference', () => {
  it.each([undefined, null, '', '0', 'true', 'on', 1, {}])('does not enable developer tools for %j', value => {
    expect(isDeveloperModeEnabled(value)).toBe(false);
  });

  it('enables developer tools only for the explicit persisted preference', () => {
    expect(isDeveloperModeEnabled('1')).toBe(true);
  });

  it('keeps business history and security available while hiding technical audits by default', () => {
    const routes = getNavigationGroups(false).flatMap(group => group.items.map(item => item.href));
    expect(routes).toContain('/agent');
    expect(routes).toContain('/activity');
    expect(routes).not.toContain('/audit');
    expect(routes).toContain('/security');
    expect(routes).not.toContain('/runs');
    expect(routes).not.toContain('/manual');
  });

  it('adds run history exclusively to the developer group', () => {
    const groups = getNavigationGroups(true);
    const runGroups = groups.filter(group => group.items.some(item => item.href === '/runs'));
    expect(runGroups).toHaveLength(1);
    expect(runGroups[0].developerOnly).toBe(true);
    expect(runGroups[0].labelKey).toBe('app.groupDeveloper');
    expect(runGroups[0].items.map(item => item.href)).toContain('/manual');
    expect(runGroups[0].items.map(item => item.href)).toContain('/audit');
  });
});
