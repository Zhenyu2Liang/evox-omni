/** Parses JSON text; returns `fallback` for null/undefined/empty/invalid input. */
export function safeParse<T>(text: string | null | undefined, fallback: T): T {
  throw new Error('not implemented');
}

/** Serializes a value to JSON text. Returns the string `'null'` when value is undefined. */
export function toJson(value: unknown): string {
  throw new Error('not implemented');
}
