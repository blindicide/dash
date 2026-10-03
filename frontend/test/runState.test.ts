import { applyEvent, newRun, type RunView } from "../src/lib/runState";
import type { RunEvent } from "../src/lib/types";

const fold = (events: RunEvent[], start: RunView = { ...newRun("s1", "hi"), runId: "run_1" }) =>
  events.reduce(applyEvent, start);

test("deltas accumulate and interleave with tools", () => {
  const v = fold([
    { type: "delta", seq: 0, text: "Hel" },
    { type: "delta", seq: 1, text: "lo" },
    { type: "tool", seq: 2, phase: "running", tool: "terminal", preview: "ls" },
    { type: "tool", seq: 3, phase: "completed", tool: "terminal", preview: "a b", duration: 0.2 },
    { type: "delta", seq: 4, text: " done" },
  ]);
  expect(v.timeline.map((t) => t.kind)).toEqual(["text", "tool", "text"]);
  expect((v.timeline[0] as { text: string }).text).toBe("Hello");
  const tool = Object.values(v.tools)[0]!;
  expect(tool).toMatchObject({ status: "completed", result: "a b", duration: 0.2 });
  expect(v.lastSeq).toBe(4);
});

test("failed, denied and stopped tool states", () => {
  const v = fold([
    { type: "tool", seq: 0, phase: "running", tool: "a", preview: "" },
    { type: "tool", seq: 1, phase: "failed", tool: "a", preview: "boom" },
    { type: "tool", seq: 2, phase: "running", tool: "terminal", preview: "rm -rf x" },
    { type: "approval", seq: 3, command: "rm -rf x", choices: ["once", "deny"], request_id: "r1" },
    { type: "approval_resolved", seq: 4, choice: "deny", request_id: "r1" },
    { type: "tool", seq: 5, phase: "completed", tool: "terminal", preview: "BLOCKED" },
    { type: "tool", seq: 6, phase: "running", tool: "web", preview: "" },
    { type: "run", seq: 7, status: "cancelled" },
  ]);
  expect(Object.values(v.tools).map((t) => t.status)).toEqual(["failed", "denied", "stopped"]);
  expect(Object.values(v.approvals)[0]).toMatchObject({ state: "resolved", choice: "deny" });
  expect(v.status).toBe("cancelled");
});

test("approval replay duplicates are ignored and pending approvals expire on terminal", () => {
  const ap: RunEvent = { type: "approval", seq: 1, command: "sudo x", choices: ["once", "session", "deny"], request_id: "r9" };
  const v = fold([ap, { ...ap, seq: null }, { type: "run", seq: 2, status: "failed", error: "x" }]);
  expect(Object.keys(v.approvals)).toHaveLength(1);
  expect(Object.values(v.approvals)[0]!.state).toBe("expired");
  expect(v.error).toBe("x");
});

test("completed output is used when nothing streamed; streamed commentary is not duplicated", () => {
  const v = fold([
    { type: "commentary", seq: 0, text: "Looking…", already_streamed: false },
    { type: "commentary", seq: 1, text: "dup", already_streamed: true },
    { type: "run", seq: 2, status: "completed", output: "Final answer", usage: { total_tokens: 9 } },
  ]);
  expect(v.timeline.map((t) => t.kind)).toEqual(["commentary", "text"]);
  expect((v.timeline[1] as { text: string }).text).toBe("Final answer");
  expect(v.usage).toEqual({ total_tokens: 9 });
});

test("historical tool status is derived from the recorded result only", async () => {
  const { historicToolStatus } = await import("../src/components/MessageItem");
  expect(historicToolStatus('{"output": "", "exit_code": -1, "error": "BLOCKED: Command denied by user."}')).toBe("denied");
  expect(historicToolStatus('{"output": "x", "exit_code": 2, "error": null}')).toBe("failed");
  expect(historicToolStatus('{"output": "hello", "exit_code": 0, "error": null}')).toBe("completed");
  expect(historicToolStatus("Error: no such file")).toBe("failed");
  expect(historicToolStatus("plain output")).toBe("completed");
  expect(historicToolStatus(undefined)).toBe("completed");
});
