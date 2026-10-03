import type { Session } from "./types";

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Hermes timestamps are epoch seconds (floats). */
export function toMs(ts: number | null | undefined): number | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  return ts < 1e12 ? ts * 1000 : ts;
}

export function sessionTitle(s: Pick<Session, "title" | "preview" | "id">): string {
  const t = (s.title || "").trim();
  if (t) return t;
  const p = (s.preview || "").trim();
  return p ? p.slice(0, 60) : "Untitled chat";
}

export type DateGroup = "Pinned" | "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

export function groupSessions(sessions: Session[], now = Date.now()): [DateGroup, Session[]][] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const day = 86_400_000;
  const order: DateGroup[] = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
  const groups = new Map<DateGroup, Session[]>(order.map((g) => [g, []]));
  for (const s of sessions) {
    const ms = toMs(s.last_active ?? s.started_at) ?? 0;
    let g: DateGroup;
    if (s.pinned) g = "Pinned";
    else if (ms >= t0) g = "Today";
    else if (ms >= t0 - day) g = "Yesterday";
    else if (ms >= t0 - 7 * day) g = "Previous 7 days";
    else if (ms >= t0 - 30 * day) g = "Previous 30 days";
    else g = "Older";
    groups.get(g)!.push(s);
  }
  return order.map((g) => [g, groups.get(g)!] as [DateGroup, Session[]]).filter(([, list]) => list.length > 0);
}

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  const ms = toMs(ts);
  if (ms === null) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
