/** Prefer the longest literal demo name when product or subscription names overlap. */
export function knownNameInText(text: string, names: Record<string, string>): string | undefined {
  let best: string | undefined;
  for (const name of Object.keys(names)) {
    if (text.includes(name) && (best === undefined || name.length > best.length)) best = name;
  }
  return best;
}
