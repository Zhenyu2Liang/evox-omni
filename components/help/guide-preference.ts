/** This browser preference contains no account or conversation data. */
export const GUIDE_SEEN_KEY = 'banking-agent:guide-dismissed';
const GUIDE_COOKIE = 'banking_guide_seen';

export function hasSeenGuide(): boolean {
  try { if (window.localStorage.getItem(GUIDE_SEEN_KEY) === '1') return true; } catch { /* Cookies can retain the preference when local storage is blocked. */ }
  try { return document.cookie.split(';').some(part => part.trim() === `${GUIDE_COOKIE}=1`); } catch { return false; }
}

export function rememberGuideClosed(): void {
  try { window.localStorage.setItem(GUIDE_SEEN_KEY, '1'); } catch { /* Keep manual help usable in restricted browsers. */ }
  try { document.cookie = `${GUIDE_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* Private browser policies may block both preference stores. */ }
}
