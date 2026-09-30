import { randomUUID } from 'node:crypto';

/** Generates a unique id, optionally prefixed for readability, e.g. `newId('pax')`. */
export function newId(prefix?: string): string {
  const uuid = randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}
