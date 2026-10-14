import { createHash } from 'node:crypto';
import { redactRequest } from '@/lib/sensitive';

const SECRET_FIELD = /^(?:password|currentPassword|newPassword|oldPassword|confirmPassword|otp|otpCode|verificationCode|mfaCode|apiKey|api_key|accessToken|refreshToken|idToken|secret|authorization|cookie|set-cookie|leaseToken|runLeaseToken)$/i;

/** Take an immediate, detached snapshot before another listener mutates a Pi event. */
export function snapshotRuntimeValue(value: unknown, redactSecrets = true): unknown {
  const ancestors = new Set<object>();
  const copy = (current: unknown, key?: string): unknown => {
    if (redactSecrets && key && SECRET_FIELD.test(key)) return '[REDACTED]';
    if (redactSecrets && key === 'code' && typeof current === 'string' && /^\d{6}$/.test(current)) return '[REDACTED]';
    if (current === null || current === undefined) return current ?? null;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'string') {
      if (!redactSecrets) return current;
      if (redactRequest(current) !== current) return '[REDACTED CREDENTIAL TEXT]';
      return current.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Runtime payload contains a non-finite number');
      return current;
    }
    if (typeof current === 'boolean') return current;
    if (typeof current !== 'object') return null;
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) return { name: current.name, message: copy(current.message), ...(typeof (current as Error & { code?: unknown }).code === 'string' ? { code: (current as Error & { code: string }).code } : {}) };
    if (ancestors.has(current)) throw new TypeError('Runtime payload contains a circular reference');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return current.map(item => copy(item));
      if (current instanceof Map) return [...current.entries()].map(([entryKey, item]) => [copy(entryKey), copy(item)]);
      if (current instanceof Set) return [...current].map(item => copy(item));
      const jsonValue = current as { toJSON?: () => unknown };
      if (typeof jsonValue.toJSON === 'function') {
        const converted = jsonValue.toJSON();
        if (converted !== current) return copy(converted);
      }
      const record = current as Record<string, unknown>;
      const argumentFragment = record.type === 'toolCall';
      const argumentDelta = record.type === 'toolcall_delta';
      return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right))
        .filter(([, item]) => item !== undefined && typeof item !== 'function')
        .map(([field, item]) => [field, redactSecrets && ((argumentFragment && field === 'partialJson') || (argumentDelta && field === 'delta')) ? '[REDACTED]' : copy(item, field)]));
    } finally {
      ancestors.delete(current);
    }
  };
  return copy(value);
}

export function encodeRuntimeValue(value: unknown): string {
  return JSON.stringify(snapshotRuntimeValue(value));
}

/** Hash the original request; redaction must never make different credentials share an identity. */
export function runtimeRequestDigest(toolName: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshotRuntimeValue({ toolName, args }, false))).digest('hex');
}
