import { timingSafeEqual } from 'node:crypto';
import { MFA_CODE } from '@/lib/constants';

export interface StepUpAuthenticator {
  readonly mode: 'demo' | 'sms';
  issue(actionId: string, recipient: string): Promise<string>;
  verify(stored: string, submitted: string): boolean;
}

/** Explicit simulator adapter. A real SMS adapter must deliver challenges out of band. */
export const demoAuthenticator: StepUpAuthenticator = {
  mode: 'demo',
  async issue() { return MFA_CODE; },
  verify(stored, submitted) {
    const expected = Buffer.from(stored);
    const actual = Buffer.from(submitted);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },
};

export function stepUpAuthenticator(): StepUpAuthenticator {
  if (process.env.MFA_MODE && process.env.MFA_MODE !== 'demo') throw new Error('A real step-up authentication adapter must be configured before using SMS mode.');
  return demoAuthenticator;
}
