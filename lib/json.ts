/** Parses JSON text; returns `fallback` for null/undefined/empty/invalid input. */
export function safeParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  const trimmed = text.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

/** Serializes a value to JSON text. Returns the string `'null'` when value is undefined. */
export function toJson(value: unknown): string {
  const out = JSON.stringify(value);
  return out === undefined ? 'null' : out;
}
