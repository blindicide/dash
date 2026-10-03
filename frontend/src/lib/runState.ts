/**
 * Pure reducer folding normalised Hermes run events into a render model.
 *
 * Tool lifecycle: Hermes v0.21.5 emits `tool.started` / `tool.completed` (with an `error`
 * flag) — there is no "queued" event and no tool-call id on the run stream, so completions are
 * matched FIFO by tool name. dash derives `denied` (a denial resolved while the tool was
 * running) and `stopped` (run ended while running); it never invents other states.
 */
import type { ApprovalChoice, RunEvent } from "./types";

export type ToolStatus = "running" | "completed" | "failed" | "denied" | "stopped";

export interface ToolCard {
  id: string;
  tool: string;
  status: ToolStatus;
  preview: string;
  result?: string;
  duration?: number;
}

export type ApprovalState = "pending" | "submitting" | "resolved" | "expired";

export interface ApprovalCard {
  id: string;
  requestId: string | null;
  command?: string;
  description?: string;
  patternKey?: string;
  choices: ApprovalChoice[];
  smartDenied: boolean;
  state: ApprovalState;
  choice?: string;
}

export type TimelineItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "commentary"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; id: string }
  | { kind: "subagent"; id: string; phase: string; text: string }
  | { kind: "notice"; id: string; text: string };

export type LiveStatus =
  | "submitting"
  | "queued"
  | "started"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface RunView {
  runId: string | null;
  sessionId: string;
  userText: string;
  userImages: string[];
  status: LiveStatus;
  timeline: TimelineItem[];
  tools: Record<string, ToolCard>;
  approvals: Record<string, ApprovalCard>;
  error?: string;
  usage?: Record<string, number>;
  model?: string;
  truncated: boolean;
  lastSeq: number | null;
}

export function newRun(sessionId: string, userText: string, userImages: string[] = []): RunView {
  return {
    runId: null,
    sessionId,
    userText,
    userImages,
    status: "submitting",
    timeline: [],
    tools: {},
    approvals: {},
    truncated: false,
    lastSeq: null,
  };
}

let counter = 0;
const uid = (p: string) => `${p}-${++counter}`;

function finalText(view: RunView): string {
  return view.timeline
    .filter((t) => t.kind === "text")
    .map((t) => (t as { text: string }).text)
    .join("");
}

export function applyEvent(view: RunView, event: RunEvent): RunView {
  const next: RunView = {
    ...view,
    timeline: [...view.timeline],
    tools: { ...view.tools },
    approvals: { ...view.approvals },
  };
  if (typeof event.seq === "number") next.lastSeq = event.seq;
  if (event.run_id && !next.runId) next.runId = event.run_id;
  if (!TERMINAL.has(next.status) && next.status !== "waiting_for_approval" && next.status !== "stopping") {
    next.status = "running";
  }

  switch (event.type) {
    case "delta": {
      const last = next.timeline[next.timeline.length - 1];
      if (last && last.kind === "text") {
        next.timeline[next.timeline.length - 1] = { ...last, text: last.text + event.text };
      } else {
        next.timeline.push({ kind: "text", id: uid("t"), text: event.text });
      }
      break;
    }
    case "commentary":
      if (!event.already_streamed && event.text.trim()) {
        next.timeline.push({ kind: "commentary", id: uid("c"), text: event.text });
      }
      break;
    case "reasoning":
      if (event.text.trim()) next.timeline.push({ kind: "reasoning", id: uid("r"), text: event.text });
      break;
    case "tool": {
      if (event.phase === "running") {
        const id = uid("tool");
        next.tools[id] = { id, tool: event.tool, status: "running", preview: event.preview };
        next.timeline.push({ kind: "tool", id });
      } else {
        const open = Object.values(next.tools).find(
          (t) => (t.status === "running" || t.status === "denied") && t.tool === event.tool && t.result === undefined,
        );
        const status: ToolStatus = event.phase === "failed" ? "failed" : "completed";
        if (open) {
          next.tools[open.id] = {
            ...open,
            status: open.status === "denied" ? "denied" : status,
            result: event.preview,
            ...(event.duration !== undefined ? { duration: event.duration } : {}),
          };
        } else {
          const id = uid("tool");
          next.tools[id] = { id, tool: event.tool, status, preview: "", result: event.preview };
          next.timeline.push({ kind: "tool", id });
        }
      }
      break;
    }
    case "subagent":
      next.timeline.push({
        kind: "subagent",
        id: uid("s"),
        phase: event.phase,
        text: event.goal || event.summary || event.status || "",
      });
      break;
    case "approval": {
      const existing = Object.values(next.approvals).find(
        (a) =>
          (event.request_id && a.requestId === event.request_id) ||
          (!event.request_id && a.state === "pending" && a.command === event.command),
      );
      if (existing) break; // replay / poll duplicate
      const id = uid("approval");
      next.approvals[id] = {
        id,
        requestId: event.request_id ?? null,
        command: event.command,
        description: event.description,
        patternKey: event.pattern_key,
        choices: event.choices?.length ? event.choices : ["once", "deny"],
        smartDenied: Boolean(event.smart_denied),
        state: "pending",
      };
      next.timeline.push({ kind: "approval", id });
      next.status = "waiting_for_approval";
      break;
    }
    case "approval_resolved": {
      const target =
        Object.values(next.approvals).find((a) => event.request_id && a.requestId === event.request_id) ??
        Object.values(next.approvals).find((a) => a.state === "pending" || a.state === "submitting");
      if (target) next.approvals[target.id] = { ...target, state: "resolved", choice: event.choice };
      if (event.choice === "deny") {
        const running = Object.values(next.tools).filter((t) => t.status === "running");
        const latest = running[running.length - 1];
        if (latest) next.tools[latest.id] = { ...latest, status: "denied" };
      }
      if (!Object.values(next.approvals).some((a) => a.state === "pending")) next.status = "running";
      break;
    }
    case "steered":
      next.timeline.push({ kind: "notice", id: uid("n"), text: "Guidance delivered to the running agent." });
      break;
    case "replay_truncated":
      next.truncated = true;
      next.timeline.push({
        kind: "notice",
        id: uid("n"),
        text: "Some live activity was missed while disconnected; the saved transcript will be reloaded when the run ends.",
      });
      break;
    case "run": {
      const status = event.status as LiveStatus;
      next.status = status;
      if (TERMINAL.has(status)) {
        for (const tool of Object.values(next.tools)) {
          if (tool.status === "running") next.tools[tool.id] = { ...tool, status: "stopped" };
        }
        for (const ap of Object.values(next.approvals)) {
          if (ap.state === "pending" || ap.state === "submitting") next.approvals[ap.id] = { ...ap, state: "expired" };
        }
        if (status === "completed" && event.output && !finalText(next).trim()) {
          next.timeline.push({ kind: "text", id: uid("t"), text: event.output });
        }
      }
      if (event.error) next.error = event.error;
      if (event.usage) next.usage = event.usage;
      if (event.runtime?.model) next.model = event.runtime.model;
      break;
    }
    default:
      break;
  }
  return next;
}

export function markApprovalSubmitting(view: RunView, id: string): RunView {
  const card = view.approvals[id];
  if (!card) return view;
  return { ...view, approvals: { ...view.approvals, [id]: { ...card, state: "submitting" } } };
}

export function markApprovalPending(view: RunView, id: string): RunView {
  const card = view.approvals[id];
  if (!card) return view;
  return { ...view, approvals: { ...view.approvals, [id]: { ...card, state: "pending" } } };
}

export function isActive(view: RunView | null): boolean {
  return Boolean(view && !TERMINAL.has(view.status));
}
