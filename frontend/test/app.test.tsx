import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DashApp } from "../src/components/DashApp";
import { FakeBff } from "./fakeBff";

let bff: FakeBff;

beforeEach(() => {
  bff = new FakeBff();
  window.__HERMES_PLUGIN_SDK__!.authedFetch = bff.fetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const runEvents = () => bff.calls.filter((c) => c.path.endsWith("/events"));

test("restores the last session and renders canonical Hermes history", async () => {
  render(<DashApp />);
  expect(await screen.findByText("hello from the CLI")).toBeInTheDocument();
  expect(screen.getByText("hi").closest("strong")).not.toBeNull();
  expect(screen.getByLabelText(/dash version/)).toHaveTextContent("\\dashvtest");
});

test("send streams a run, shows tool + approval cards, approval needs an explicit click", async () => {
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  const box = screen.getByLabelText("Message Hermes");
  fireEvent.change(box, { target: { value: "list files" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(runEvents()).toHaveLength(1));
  const post = bff.calls.find((c) => c.path === "/runs")!;
  expect(post.headers.get("X-Dash-Request")).toBe("1");
  expect((post.body as { client_request_id: string }).client_request_id).toMatch(/^[0-9a-f-]{36}$/);
  const rid = "run_" + "1".padStart(32, "0");
  act(() => {
    bff.event(rid, 0, { type: "delta", text: "Checking" });
    bff.event(rid, 1, { type: "tool", phase: "running", tool: "terminal", preview: "rm -rf build" });
    bff.event(rid, 2, { type: "approval", command: "rm -rf build", description: "recursive delete", choices: ["once", "session", "deny"], request_id: "req1" });
  });
  const card = await screen.findByRole("alertdialog", { name: "Approval required" });
  expect(within(card).getByText("rm -rf build")).toBeInTheDocument();
  expect(bff.calls.some((c) => c.path.endsWith("/approval"))).toBe(false); // never automatic
  fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(bff.calls.find((c) => c.path.endsWith("/approval"))?.body).toEqual({ choice: "deny", request_id: "req1" }));
  bff.messages.s_old!.push({ id: 3, role: "user", content: "list files" }, { id: 4, role: "assistant", content: "Denied, so nothing was removed." });
  act(() => {
    bff.event(rid, 3, { type: "tool", phase: "completed", tool: "terminal", preview: "blocked" });
    bff.event(rid, 4, { type: "run", status: "completed", output: "Denied, so nothing was removed." });
    bff.end(rid);
  });
  expect(await screen.findByText("Denied, so nothing was removed.")).toBeInTheDocument();
});

test("network drop reconnects with Last-Event-ID and never resends or stops", async () => {
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  const box = screen.getByLabelText("Message Hermes");
  fireEvent.change(box, { target: { value: "long task" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runEvents()).toHaveLength(1));
  const rid = "run_" + "1".padStart(32, "0");
  act(() => {
    bff.event(rid, 0, { type: "delta", text: "part one " });
    bff.event(rid, 1, { type: "delta", text: "part two" });
  });
  await screen.findByText(/part one part two/);
  act(() => bff.drop(rid));
  await waitFor(() => expect(runEvents()).toHaveLength(2), { timeout: 4000 });
  expect(runEvents()[1]!.headers.get("Last-Event-ID")).toBe("1");
  act(() => bff.event(rid, 1, { type: "delta", text: "part two" })); // replayed duplicate is dropped
  act(() => bff.event(rid, 2, { type: "delta", text: " three" }));
  await screen.findByText(/part one part two three/);
  expect(bff.calls.filter((c) => c.path === "/runs")).toHaveLength(1);
  expect(bff.calls.some((c) => c.path.endsWith("/stop"))).toBe(false);
});

test("reload re-attaches to an active run instead of resending", async () => {
  bff.activeRun.s_old = "run_" + "7".padStart(32, "0");
  render(<DashApp />);
  await waitFor(() => expect(runEvents()).toHaveLength(1));
  expect(runEvents()[0]!.path).toBe(`/runs/${bff.activeRun.s_old}/events`);
  expect(runEvents()[0]!.headers.get("Last-Event-ID")).toBeNull(); // full replay from Hermes' backlog
  expect(bff.calls.some((c) => c.path === "/runs" && c.method === "POST")).toBe(false);
  expect(await screen.findByRole("button", { name: "Stop the running agent" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop the running agent" }));
  await waitFor(() => expect(bff.calls.some((c) => c.path.endsWith("/stop"))).toBe(true));
});

test("profile switch isolates state and scopes every request", async () => {
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  fireEvent.change(screen.getByLabelText("Hermes profile"), { target: { value: "work" } });
  await waitFor(() => expect(screen.queryByText("hello from the CLI")).toBeNull());
  await screen.findByText("Start a conversation with Hermes");
  const after = bff.calls.slice(bff.calls.findIndex((c) => c.query.get("profile") === "work"));
  expect(after.filter((c) => c.path !== "/profiles").every((c) => c.query.get("profile") === "work")).toBe(true);
  expect(window.localStorage.getItem("hermes-dash:profile")).toBe("work");
});

test("a late load-more response from the old profile is discarded", async () => {
  const upstream = bff.fetch;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const requested = new Promise<void>((resolve) => (started = resolve));
  window.__HERMES_PLUGIN_SDK__!.authedFetch = async (url, init = {}) => {
    const u = new URL(url, "http://dash.test");
    if (u.pathname === "/api/plugins/dash/sessions" && !u.searchParams.has("profile")) {
      if (u.searchParams.get("offset") === "0") {
        return new Response(JSON.stringify({ sessions: bff.sessions, has_more: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      started();
      await gate;
      return new Response(
        JSON.stringify({ sessions: [{ id: "late-default", title: "Private default chat", is_bot_chat: false }], has_more: false }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    return upstream(url, init);
  };
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await requested;
  fireEvent.change(screen.getByLabelText("Hermes profile"), { target: { value: "work" } });
  await screen.findByText("Start a conversation with Hermes");
  release();
  await act(async () => undefined);
  expect(screen.queryByText("Private default chat")).toBeNull();
});

test("an accepted first message does not reappear as the next new-chat draft", async () => {
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  const box = screen.getByLabelText("Message Hermes");
  fireEvent.change(box, { target: { value: "one-time draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(runEvents()).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  await waitFor(() => expect(screen.getByLabelText("Message Hermes")).toHaveValue(""));
});

test("a lost image submission retries with the same client request id", async () => {
  const upstream = bff.fetch;
  let first = true;
  window.__HERMES_PLUGIN_SDK__!.authedFetch = async (url, init = {}) => {
    const u = new URL(url, "http://dash.test");
    if (u.pathname === "/api/plugins/dash/runs" && (init.method ?? "GET") === "POST" && first) {
      first = false;
      await upstream(url, init); // Hermes accepted it; only the browser lost the response.
      throw new TypeError("connection dropped after acceptance");
    }
    return upstream(url, init);
  };
  const { container } = render(<DashApp />);
  await screen.findByText("hello from the CLI");
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="image/png"]')!;
  const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "pixel.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByAltText("Preview of pixel.png");
  fireEvent.change(screen.getByLabelText("Message Hermes"), { target: { value: "inspect image" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/Network disconnected/);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(bff.calls.filter((c) => c.path === "/runs")).toHaveLength(2));
  const sends = bff.calls.filter((c) => c.path === "/runs").map((c) => c.body as { client_request_id: string });
  expect(sends[1]!.client_request_id).toBe(sends[0]!.client_request_id);
});

test("Ctrl+K opens search without intercepting plain Ctrl+N", async () => {
  render(<DashApp />);
  await screen.findByText("hello from the CLI");
  const n = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(n);
  expect(n.defaultPrevented).toBe(false);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(await screen.findByRole("searchbox", { name: "Search conversations" })).toBeInTheDocument();
});
