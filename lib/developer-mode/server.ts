import { cache } from 'react';
import { cookies } from 'next/headers';
import { DEVELOPER_MODE_COOKIE, isDeveloperModeEnabled } from './shared';

export const getServerDeveloperMode = cache(async () => {
  const cookieStore = await cookies();
  return isDeveloperModeEnabled(cookieStore.get(DEVELOPER_MODE_COOKIE)?.value);
});
