import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { httpModelFailure, retryableModelFailure, type AuditedAssistantMessage, type ModelFailure } from '@/agent/providers/model-failure';

const failed = (bankingFailure?: ModelFailure, errorMessage = 'Arbitrary provider wording'): AuditedAssistantMessage => ({
  ...fauxAssistantMessage('', { stopReason: 'error', errorMessage }), ...(bankingFailure ? { bankingFailure } : {}),
});

describe('typed model failure policy', () => {
  it.each([400, 401, 403, 404, 422])('treats HTTP %s as permanent independently of misleading error prose', status => {
    const failure = httpModelFailure(status);
    expect(failure).toEqual({ kind: 'http', status, retryable: false });
    expect(retryableModelFailure(failed(failure, 'Network timeout 429; please retry'))).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])('treats HTTP %s as transient independently of misleading error prose', status => {
    const failure = httpModelFailure(status);
    expect(failure).toEqual({ kind: 'http', status, retryable: true });
    expect(retryableModelFailure(failed(failure, 'Authentication denied 401'))).toBe(true);
  });

  it('does not infer retry permission from provider wording without transport evidence', () => {
    expect(retryableModelFailure(failed(undefined, 'timeout network ECONN 429 503'))).toBe(false);
    expect(retryableModelFailure(failed({ kind: 'provider', retryable: false }, 'timeout network 503'))).toBe(false);
  });

  it('retains caller cancellation as permanent and transport deadlines as retryable', () => {
    expect(retryableModelFailure(failed({ kind: 'cancelled', retryable: false }))).toBe(false);
    expect(retryableModelFailure(failed({ kind: 'timeout', retryable: true }))).toBe(true);
    expect(retryableModelFailure(failed({ kind: 'transport', retryable: true }))).toBe(true);
  });
});
