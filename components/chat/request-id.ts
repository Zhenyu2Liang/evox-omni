/** The browser cannot safely identify a new request without a random source. */
export class RequestIdUnavailableError extends Error {
  constructor() {
    super('This browser cannot create a request ID. Use a current browser and try again.');
    this.name = 'RequestIdUnavailableError';
  }
}

/**
 * Create a transport admission ID, never an authorization or banking operation key.
 * Unlike randomUUID, getRandomValues is available on ordinary HTTP browser pages.
 */
export function createRequestId(): string {
  const cryptoSource = globalThis.crypto;
  if (typeof cryptoSource?.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }
  if (typeof cryptoSource?.getRandomValues !== 'function') {
    throw new RequestIdUnavailableError();
  }

  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
