export const DEVELOPER_MODE_COOKIE = 'banking_developer_mode';
export const DEVELOPER_MODE_ENABLED = '1';

/** This preference controls demo tools, not user authentication. */
export function isDeveloperModeEnabled(value: unknown): boolean {
  return value === DEVELOPER_MODE_ENABLED;
}
