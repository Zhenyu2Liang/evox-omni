import { AppError } from './errors';

/** Canonical origins come from deployment configuration, never from proxy or browser headers. */
export function trustedRequestOrigin(req: Request, origin: string | null = null): string {
  const target = new URL(req.url);
  const host = req.headers.get('host');
  if (host) {
    if (/[\s,/@\\]/.test(host)) throw new AppError('SECURITY_DENIED', 'Invalid request host.');
    try {
      const destination = new URL(`${target.protocol}//${host}`);
      if (destination.host !== host.toLowerCase()) throw new Error('Invalid host');
      target.host = destination.host;
    } catch { throw new AppError('SECURITY_DENIED', 'Invalid request host.'); }
  }
  const configured = process.env.BANKING_ALLOWED_ORIGINS?.trim();
  if (!configured) {
    if (['http:', 'https:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return target.origin;
  } else {
    for (const entry of configured.split(',')) {
      try {
        const allowed = new URL(entry.trim());
        // Explicit HTTPS origins also support TLS termination before Next's HTTP listener.
        if (['http:', 'https:'].includes(allowed.protocol) && !allowed.username && !allowed.password &&
            allowed.pathname === '/' && !allowed.search && !allowed.hash && allowed.host === target.host &&
            (origin === null || origin === allowed.origin)) return allowed.origin;
      } catch { /* Invalid configuration never adds trust. */ }
    }
  }
  throw new AppError('SECURITY_DENIED', 'Request host is not trusted.');
}
