import { publicSafeMessage } from './internal-text';

export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'INSUFFICIENT_FUNDS' | 'LIMIT_EXCEEDED' | 'SECURITY_DENIED' | 'MFA_FAILED' | 'MFA_LOCKED' | 'CIRCUIT_OPEN' | 'MANUAL_REVIEW_HOLD' | 'CONFLICT' | 'TOOL_FAILED' | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Internal payload for diagnostics, logs and the developer panel — never rendered to the user. */
  readonly detail?: unknown;
  /**
   * PUBLIC-SAFE form of `message`, derived at construction: the original text when it is a renderable
   * business message, `undefined` when it is missing or an internal diagnostic (`__SECURITY_BLOCK__…`
   * payload, raw JSON, stack trace). `undefined` means "use the catalog fallback" — see
   * `@/lib/public-text` `publicErrorMessage`. `message` itself stays untouched for the logs.
   */
  readonly publicMessage?: string;
  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
    const safe = publicSafeMessage(message);
    if (safe !== undefined) this.publicMessage = safe;
  }
  static from(e: unknown): AppError { if (e instanceof AppError) return e; if (e instanceof Error) return new AppError('INTERNAL', e.message, e); return new AppError('INTERNAL', String(e)); }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: AppError): Result<T> => ({ ok: false, error });
