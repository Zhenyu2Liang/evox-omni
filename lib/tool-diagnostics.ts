import { redactRequest } from './sensitive';

const SECRET_FIELD = /password|passwd|pwd|passphrase|pin|secret|credential|token|authorization|cookie|api[_-]?key|verification|otp|mfa/i;

/** Diagnostic data never contains credentials, full phone numbers, reasoning or executable markup. */
export function sanitizeToolArguments(value: unknown): unknown {
  const ancestors = new Set<object>();
  let remaining = 500;
  const copy = (current: unknown, key = '', depth = 0): unknown => {
    if (SECRET_FIELD.test(key) || /^(?:thinking|reasoning|partialJson)$/i.test(key)) return '[REDACTED]';
    if (depth > 8 || remaining-- <= 0) return '[TRUNCATED]';
    if (current === null || current === undefined) return null;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'number') {
      if (key === 'code' && /^\d{6}$/.test(String(current))) return '[REDACTED]';
      if (/phone|mobile/i.test(key) && /^\d{7,}$/.test(String(current))) return `****${String(current).slice(-4)}`;
      return Number.isFinite(current) ? current : '[INVALID NUMBER]';
    }
    if (typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (redactRequest(current) !== current) return '[REDACTED CREDENTIAL TEXT]';
      if (key === 'code' && /^\d{6}$/.test(current)) return '[REDACTED]';
      if (/phone|mobile/i.test(key) && /^\+?[\d -]{7,}$/.test(current)) return `****${current.slice(-4)}`;
      if (/^[\[{]/.test(current.trim())) {
        try { return copy(JSON.parse(current), key, depth + 1); } catch { /* Keep ordinary strings inert. */ }
      }
      return current.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
        .replace(/\b(?:password|passwd|pwd|passphrase|pin|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[REDACTED]')
        .slice(0, 4000);
    }
    if (typeof current !== 'object') return '[UNSUPPORTED]';
    if (ancestors.has(current)) return '[CIRCULAR]';
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.slice(0, 100).map(item => copy(item, '', depth + 1));
      return Object.fromEntries(Object.entries(current).slice(0, 100).map(([field, item]) => [field, copy(item, field, depth + 1)]));
    } finally { ancestors.delete(current); }
  };
  return copy(value);
}
