/** Demo password operations accept no credentials. Strip them before model, transcript and audit. */
export function redactRequest(text: string): string {
  if (/(?:密码\s*(?:是|为|[:：]|[a-z0-9])|\b(?:current|new|old)?password["']?\s*[:=])/i.test(text)) {
    return '演示修改密码流程（凭证已脱敏；演示环境不接受或保存真实密码）。';
  }
  return text;
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, /password|verificationCode|apiKey|secret/i.test(key) ? '[已脱敏]' : redactSecrets(entry)]));
  if (typeof value === 'string') {
    if (/^[\[{]/.test(value.trim())) {
      try { return JSON.stringify(redactSecrets(JSON.parse(value))); } catch { /* Plain text, not JSON. */ }
    }
    return redactRequest(value);
  }
  return value;
}
