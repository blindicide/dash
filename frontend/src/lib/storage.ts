/**
 * Browser storage — harmless, device-local conveniences only.
 * - localStorage: selected profile name, sidebar collapsed.
 * - sessionStorage (tab-scoped, cleared when the tab closes): unsent composer drafts and the
 *   pending-submission record that makes a network-failed send retry idempotently.
 * Never credentials, never conversation history (Hermes owns that).
 */
const PREFIX = "hermes-dash:";

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const local = {
  get: (key: string): string | null => safe(() => window.localStorage.getItem(PREFIX + key), null),
  set: (key: string, value: string | null) =>
    safe(() => {
      if (value === null) window.localStorage.removeItem(PREFIX + key);
      else window.localStorage.setItem(PREFIX + key, value);
    }, undefined),
};

export const tab = {
  get: (key: string): string | null => safe(() => window.sessionStorage.getItem(PREFIX + key), null),
  set: (key: string, value: string | null) =>
    safe(() => {
      if (value === null) window.sessionStorage.removeItem(PREFIX + key);
      else window.sessionStorage.setItem(PREFIX + key, value);
    }, undefined),
};

export function draftKey(profile: string, sessionId: string | null): string {
  return `draft:${profile}:${sessionId ?? "new"}`;
}

export interface PendingSubmission {
  sessionId: string;
  clientRequestId: string;
  text: string;
  at: number;
}

export function pendingKey(profile: string, sessionId: string): string {
  return `pending:${profile}:${sessionId}`;
}

export function readPending(profile: string, sessionId: string): PendingSubmission | null {
  const raw = tab.get(pendingKey(profile, sessionId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingSubmission;
    // Hermes keeps idempotency keys 24 h; after an hour a retry is a new message, not a resend.
    return Date.now() - p.at < 3_600_000 ? p : null;
  } catch {
    return null;
  }
}
