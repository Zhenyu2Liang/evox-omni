import type { NextRequest } from 'next/server';
import { DEVELOPER_MODE_COOKIE, isDeveloperModeEnabled } from '@/lib/developer-mode/shared';
import { AppError } from '@/lib/errors';

/** This preference exposes demo diagnostics; it is not a production authentication mechanism. */
export function requireDeveloperMode(request: NextRequest): void {
  if (!isDeveloperModeEnabled(request.cookies.get(DEVELOPER_MODE_COOKIE)?.value)) {
    throw new AppError('SECURITY_DENIED', 'Enable developer mode before using this demo control.');
  }
}
