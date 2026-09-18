import type { Session } from './api';

/**
 * Where the browser keeps the current session.
 *
 * sessionStorage rather than localStorage: a demo session should not outlive
 * the tab, and nothing here is a credential the user chose.
 */
const KEY = 'netra.session';

export function loadSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.token || !parsed.workspaceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Private browsing can refuse storage; the session still works in-memory
    // for this page load.
  }
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up */
  }
}
