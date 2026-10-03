/**
 * Browser client for the dash BFF. Only relative `/api/plugins/dash/...` paths are used; the
 * host SDK adds the Dashboard base path and auth (session-token header or OAuth cookie). The
 * browser never sees a Hermes URL or credential and never talks to the Hermes API server.
 */
import type {
  Capabilities,
  ModelChoice,
  ModelChoices,
  Message,
  Preferences,
  ProfileItem,
  RunRecord,
  Session,
  Status,
  UploadRef,
} from "./types";

export const BFF = "/api/plugins/dash";

export type ErrorKind = "network" | "auth" | "http" | "unsupported";

export class DashApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly kind: ErrorKind;

  constructor(message: string, opts: { status: number; code: string; retryable?: boolean; kind: ErrorKind }) {
    super(message);
    this.name = "DashApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.kind = opts.kind;
  }
}

export function getSDK(): HermesPluginSDK {
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!sdk) throw new DashApiError("Hermes plugin SDK not available.", { status: 0, code: "no_sdk", kind: "unsupported" });
  return sdk;
}

/** Streaming (SSE over fetch) needs the raw Response, i.e. SDK.authedFetch (SDK ≥ 1.1). */
export function supportsStreaming(): boolean {
  return typeof window.__HERMES_PLUGIN_SDK__?.authedFetch === "function";
}

export function withProfile(path: string, profile: string | null | undefined, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra ?? {});
  if (profile) params.set("profile", profile);
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

async function parseError(res: Response): Promise<DashApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const env = (body as { error?: unknown; detail?: { error?: unknown } } | null) ?? {};
  const err = (env.error ?? env.detail?.error) as { code?: string; message?: string; retryable?: boolean } | undefined;
  if (res.status === 401) {
    return new DashApiError("Your Dashboard session expired. Reload the page to sign in again.", {
      status: 401,
      code: "dashboard_auth_expired",
      kind: "auth",
    });
  }
  return new DashApiError(err?.message || `Request failed (HTTP ${res.status}).`, {
    status: res.status,
    code: err?.code || `http_${res.status}`,
    retryable: err?.retryable ?? res.status >= 500,
    kind: "http",
  });
}

export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const sdk = getSDK();
  if (!sdk.authedFetch) {
    throw new DashApiError("This Hermes Dashboard is too old for raw requests.", {
      status: 0,
      code: "sdk_too_old",
      kind: "unsupported",
    });
  }
  try {
    return await sdk.authedFetch(path, init);
  } catch {
    throw new DashApiError("Network unavailable — cannot reach the Hermes Dashboard.", {
      status: 0,
      code: "network",
      retryable: true,
      kind: "network",
    });
  }
}

interface CallOpts {
  body?: unknown;
  profile?: string | null;
  signal?: AbortSignal;
  query?: Record<string, string>;
}

export async function call<T>(method: string, path: string, opts: CallOpts = {}): Promise<T> {
  const url = withProfile(`${BFF}${path}`, opts.profile, opts.query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Dash-Request"] = "1";
  const init: RequestInit = { method, headers, signal: opts.signal };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const sdk = getSDK();
  if (!sdk.authedFetch) {
    // SDK < 1.1 fallback: fetchJSON parses JSON and throws on non-2xx.
    try {
      return await sdk.fetchJSON<T>(url, init);
    } catch (e) {
      throw new DashApiError(e instanceof Error ? e.message : "Request failed.", {
        status: 0,
        code: "request_failed",
        retryable: true,
        kind: "http",
      });
    }
  }
  const res = await rawFetch(url, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const api = {
  status: (profile?: string | null) => call<Status>("GET", "/status", { profile }),
  capabilities: (profile?: string | null) =>
    call<{ profile: string; capabilities: Capabilities }>("GET", "/capabilities", { profile }),
  profiles: () => call<{ launch_profile: string; profiles: ProfileItem[] }>("GET", "/profiles"),
  sessions: (profile: string | null, limit = 50, offset = 0) =>
    call<{ sessions: Session[]; has_more: boolean }>("GET", "/sessions", {
      profile,
      query: { limit: String(limit), offset: String(offset) },
    }),
  search: (profile: string | null, q: string, signal?: AbortSignal) =>
    call<{ sessions: Session[]; scanned: number; truncated: boolean }>("GET", "/sessions/search", {
      profile,
      signal,
      query: { q },
    }),
  createSession: (profile: string | null, title?: string) =>
    call<{ session: Session }>("POST", "/sessions", { profile, body: title ? { title } : {} }),
  session: (profile: string | null, id: string) =>
    call<{ session: Session }>("GET", `/sessions/${encodeURIComponent(id)}`, { profile }),
  patchSession: (profile: string | null, id: string, fields: Partial<Pick<Session, "title" | "pinned" | "archived">>) =>
    call<{ session: Session }>("PATCH", `/sessions/${encodeURIComponent(id)}`, { profile, body: fields }),
  deleteSession: (profile: string | null, id: string) =>
    call<{ deleted: boolean }>("DELETE", `/sessions/${encodeURIComponent(id)}`, { profile }),
  messages: (profile: string | null, id: string, limit = 200) =>
    call<{ session_id: string; messages: Message[]; returned: number }>(
      "GET",
      `/sessions/${encodeURIComponent(id)}/messages`,
      { profile, query: { limit: String(limit), order: "latest" } },
    ),
  fork: (profile: string | null, id: string, title?: string) =>
    call<{ session: Session }>("POST", `/sessions/${encodeURIComponent(id)}/fork`, {
      profile,
      body: title ? { title } : {},
    }),
  activeRun: (profile: string | null, id: string) =>
    call<{ run: RunRecord | null; client_request_id?: string }>("GET", `/sessions/${encodeURIComponent(id)}/active-run`, {
      profile,
    }),
  state: (profile: string | null) =>
    call<{ profile: string; last_session_id: string | null; preferences: Preferences }>("GET", "/state", { profile }),
  setLastSession: (profile: string | null, sessionId: string | null) =>
    call<{ last_session_id: string | null }>("PUT", "/state/last-session", { profile, body: { session_id: sessionId } }),
  setPreferences: (profile: string | null, patch: Partial<Preferences>) =>
    call<{ preferences: Preferences }>("PUT", "/preferences", { profile, body: patch }),
  botChat: (profile: string | null) => call<{ session: Session | null }>("GET", "/bot-chat", { profile }),
  ensureBotChat: (profile: string | null) =>
    call<{ session: Session; created: boolean }>("POST", "/bot-chat", { profile }),
  createRun: (
    profile: string | null,
    body: {
      session_id: string;
      text: string;
      client_request_id: string;
      images?: { mime: string; data: string }[];
      uploads?: string[];
      model?: ModelChoice;
    },
  ) => call<{ run_id: string; status: string; replayed: boolean; session_id: string }>("POST", "/runs", { profile, body }),
  run: (profile: string | null, runId: string) => call<{ run: RunRecord }>("GET", `/runs/${runId}`, { profile }),
  stop: (profile: string | null, runId: string) =>
    call<{ run_id: string; status: string }>("POST", `/runs/${runId}/stop`, { profile }),
  approve: (profile: string | null, runId: string, choice: string, requestId?: string | null) =>
    call<{ choice: string; resolved: number }>("POST", `/runs/${runId}/approval`, {
      profile,
      body: requestId ? { choice, request_id: requestId } : { choice },
    }),
  models: (profile: string | null) => call<{ model_options: unknown }>("GET", "/hermes/models", { profile }),
  modelChoices: (profile: string | null) => call<ModelChoices>("GET", "/models/choices", { profile }),
  skills: (profile: string | null) =>
    call<{ skills: { name: string; description?: string; category?: string; enabled?: boolean }[] }>(
      "GET",
      "/hermes/skills",
      { profile },
    ),
  toolsets: (profile: string | null) =>
    call<{
      toolsets: { name: string; label?: string; description?: string; enabled: boolean; configured: boolean; tools: string[] }[];
    }>("GET", "/hermes/toolsets", { profile }),
  async upload(profile: string | null, file: File): Promise<UploadRef> {
    const res = await rawFetch(withProfile(`${BFF}/uploads`, profile), {
      method: "POST",
      headers: {
        "X-Dash-Request": "1",
        "X-Dash-Filename": encodeURIComponent(file.name),
        "Content-Type": "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) throw await parseError(res);
    return ((await res.json()) as { upload: UploadRef }).upload;
  },
};
