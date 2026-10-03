import { api, call, DashApiError, withProfile } from "../src/lib/api";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

test("profile param is only added for non-launch profiles", () => {
  expect(withProfile("/api/plugins/dash/sessions", null)).toBe("/api/plugins/dash/sessions");
  expect(withProfile("/api/plugins/dash/sessions", "work", { limit: "5" })).toBe("/api/plugins/dash/sessions?limit=5&profile=work");
});

test("mutations carry the dash header; GETs do not", async () => {
  const f = respond(200, { ok: true });
  window.__HERMES_PLUGIN_SDK__!.authedFetch = f;
  await call("GET", "/x");
  await call("POST", "/y", { body: { a: 1 } });
  const calls = f.mock.calls as unknown as [string, RequestInit][];
  expect(new Headers(calls[0]![1].headers).get("X-Dash-Request")).toBeNull();
  expect(new Headers(calls[1]![1].headers).get("X-Dash-Request")).toBe("1");
  expect(calls[1]![0]).toBe("/api/plugins/dash/y");
});

test("error envelopes (direct and FastAPI detail) and 401 are classified", async () => {
  window.__HERMES_PLUGIN_SDK__!.authedFetch = respond(503, { error: { code: "hermes_unavailable", message: "down", retryable: true } });
  await expect(api.sessions(null)).rejects.toMatchObject({ code: "hermes_unavailable", retryable: true, kind: "http" });
  window.__HERMES_PLUGIN_SDK__!.authedFetch = respond(403, { detail: { error: { code: "cross_origin", message: "no" } } });
  await expect(api.createSession(null)).rejects.toMatchObject({ code: "cross_origin", status: 403 });
  window.__HERMES_PLUGIN_SDK__!.authedFetch = respond(401, { detail: "Unauthorized" });
  await expect(api.sessions(null)).rejects.toMatchObject({ kind: "auth", code: "dashboard_auth_expired" });
  window.__HERMES_PLUGIN_SDK__!.authedFetch = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  const err = await api.sessions(null).catch((e) => e);
  expect(err).toBeInstanceOf(DashApiError);
  expect(err.kind).toBe("network");
});
