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
  fingerprint: string;
  at: number;
}

interface SubmissionFingerprintInput {
  text: string;
  images: { mime: string; data: string }[];
  uploads: string[];
  model: { provider: string; model: string } | null;
}

/**
 * Hash the exact run payload that a pending client_request_id belongs to. Keeping only the
 * digest avoids persisting image bytes or upload metadata in sessionStorage. A non-crypto
 * fallback supports restricted/legacy webviews; a collision is still fail-safe because
 * Hermes rejects an idempotency key reused with a different upstream payload.
 */
export async function submissionFingerprint(input: SubmissionFingerprintInput): Promise<string> {
  const canonical = JSON.stringify(input);
  const bytes = new TextEncoder().encode(canonical);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ byte, 0x85ebca6b) >>> 0;
  }
  return `fallback-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
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
    return typeof p.fingerprint === "string" && p.fingerprint && Date.now() - p.at < 3_600_000 ? p : null;
  } catch {
    return null;
  }
}
