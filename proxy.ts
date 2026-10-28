import { NextResponse, type NextRequest } from 'next/server';
import { trustedRequestOrigin } from './lib/request-origin';

/** Check reads and server-rendered pages too: host trust is wider than write-CSRF protection. */
export function proxy(request: NextRequest) {
  try {
    trustedRequestOrigin(request);
    return NextResponse.next();
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'SECURITY_DENIED', message: 'Request host is not trusted.' } },
      { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
}
