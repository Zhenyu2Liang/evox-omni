export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'INSUFFICIENT_FUNDS' | 'LIMIT_EXCEEDED' | 'SECURITY_DENIED' | 'MFA_FAILED' | 'CIRCUIT_OPEN' | 'CONFLICT' | 'TOOL_FAILED' | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;
  constructor(code: ErrorCode, message: string, detail?: unknown) { super(message); this.name = 'AppError'; this.code = code; this.detail = detail; }
  static from(e: unknown): AppError { if (e instanceof AppError) return e; if (e instanceof Error) return new AppError('INTERNAL', e.message, e); return new AppError('INTERNAL', String(e)); }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: AppError): Result<T> => ({ ok: false, error });
