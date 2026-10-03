/**
 * Resumable subscription to one Hermes run via the BFF.
 *
 * - The run lives in Hermes; this object only *watches* it. Closing it (navigation, refresh,
 *   phone sleep) never cancels the run — only the explicit Stop button calls Hermes' stop API.
 * - Every event carries Hermes' sequence number; reconnects send `Last-Event-ID` so Hermes
 *   replays exactly what was missed (its backlog keeps the last 1000 events), and duplicates
 *   are dropped client-side.
 * - Reconnect with capped exponential backoff; wake immediately on `online` /
 *   `visibilitychange`. Hermes sends a keepalive every 10 s (forwarded by the BFF), so a
 *   silent connection — typical after phone sleep or a network change leaves it half-open —
 *   is aborted and resumed instead of hanging in "open". When streaming is impossible (SDK
 *   without authedFetch) it degrades to polling the run status, which still surfaces
 *   approvals and the final answer.
 */
import { api, BFF, DashApiError, rawFetch, supportsStreaming, withProfile } from "./api";
import { TERMINAL } from "./runState";
import { SSEParser } from "./sse";
import type { RunEvent, RunRecord } from "./types";

export type StreamState = "connecting" | "open" | "reconnecting" | "polling" | "closed" | "failed";

export interface RunStreamOptions {
  profile: string | null;
  runId: string;
  lastSeq?: number | null;
  onEvent: (event: RunEvent) => void;
  onState?: (state: StreamState, detail?: string) => void;
}

const MAX_BACKOFF_MS = 15_000;
const POLL_MS = 2_000;
const STATUS_CHECK_AFTER_FAILURES = 4;
/** No bytes (not even a keepalive) for this long: the connection is dead. */
const IDLE_TIMEOUT_MS = 45_000;
/** On wake, a connection silent for longer than one keepalive interval is presumed stale. */
const STALE_ON_WAKE_MS = 15_000;

export class RunStream {
  private closed = false;
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private lastSeq: number | null;
  private failures = 0;
  private lastActivity = 0;
  private reading = false;
  private sawTerminal = false;
  private readonly opts: RunStreamOptions;

  constructor(opts: RunStreamOptions) {
    this.opts = opts;
    this.lastSeq = opts.lastSeq ?? null;
    this.onWake = this.onWake.bind(this);
  }

  get seq(): number | null {
    return this.lastSeq;
  }

  start(): this {
    window.addEventListener("online", this.onWake);
    document.addEventListener("visibilitychange", this.onWake);
    void (supportsStreaming() ? this.streamLoop() : this.pollLoop());
    return this;
  }

  /** Stop watching. Does NOT stop the Hermes run. */
  close(): void {
    this.closed = true;
    this.abort?.abort();
    this.wake?.();
    window.removeEventListener("online", this.onWake);
    document.removeEventListener("visibilitychange", this.onWake);
  }

  private onWake(): void {
    if (document.visibilityState !== "visible" || navigator.onLine === false) return;
    if (this.reading && Date.now() - this.lastActivity > STALE_ON_WAKE_MS) this.abort?.abort();
    this.wake?.();
  }

  private setState(state: StreamState, detail?: string): void {
    if (!this.closed || state === "closed") this.opts.onState?.(state, detail);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = window.setTimeout(done, ms);
      function done() {
        window.clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private deliver(event: RunEvent): void {
    if (typeof event.seq === "number") {
      if (this.lastSeq !== null && event.seq <= this.lastSeq) return; // replay duplicate
      this.lastSeq = event.seq;
    }
    if (event.type === "run" && TERMINAL.has(String(event.status))) this.sawTerminal = true;
    this.opts.onEvent(event);
  }

  private finishFromStatus(run: RunRecord): boolean {
    if (!run.terminal) return false;
    this.sawTerminal = true;
    this.opts.onEvent({
      type: "run",
      seq: null,
      run_id: run.run_id,
      status: String(run.status),
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    });
    return true;
  }

  private async checkStatus(): Promise<"terminal" | "active" | "gone" | "unknown"> {
    try {
      const { run } = await api.run(this.opts.profile, this.opts.runId);
      if (run.status === "waiting_for_approval" && run.approval) this.opts.onEvent(run.approval);
      return this.finishFromStatus(run) ? "terminal" : "active";
    } catch (e) {
      if (e instanceof DashApiError && e.status === 404) return "gone";
      return "unknown";
    }
  }

  private async streamLoop(): Promise<void> {
    while (!this.closed) {
      if (navigator.onLine === false) {
        this.setState("reconnecting", "offline");
        await this.sleep(MAX_BACKOFF_MS);
        continue;
      }
      this.setState(this.failures === 0 ? "connecting" : "reconnecting");
      const outcome = await this.connectOnce();
      if (this.closed) break;
      if (outcome === "done") {
        // The stream ended; make sure the UI saw how the run settled before closing.
        const status = this.sawTerminal ? "terminal" : await this.checkStatus();
        if (this.closed) break;
        if (status !== "active" && status !== "unknown") {
          this.close();
          this.setState(status === "gone" ? "failed" : "closed", status === "gone" ? "run_not_found" : undefined);
          return;
        }
      }
      if (outcome === "fatal") {
        this.close();
        this.setState("failed");
        return;
      }
      this.failures += 1;
      if (this.failures >= STATUS_CHECK_AFTER_FAILURES) {
        const status = await this.checkStatus();
        if (status === "terminal" || status === "gone") {
          this.close();
          this.setState(status === "gone" ? "failed" : "closed", status === "gone" ? "run_not_found" : undefined);
          return;
        }
      }
      await this.sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.failures, 5)));
    }
  }

  /** One connection. Returns "done" (terminal), "retry" (transient), or "fatal". */
  private async connectOnce(): Promise<"done" | "retry" | "fatal"> {
    this.abort = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.lastSeq !== null) headers["Last-Event-ID"] = String(this.lastSeq);
    let res: Response;
    try {
      res = await rawFetch(withProfile(`${BFF}/runs/${this.opts.runId}/events`, this.opts.profile), {
        headers,
        signal: this.abort.signal,
        cache: "no-store",
      });
    } catch {
      return "retry";
    }
    if (res.status === 401) {
      this.setState("failed", "dashboard_auth_expired");
      return "fatal";
    }
    if (!res.ok || !res.body) return res.status >= 500 || res.status === 0 ? "retry" : "fatal";
    this.setState("open");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    const abort = this.abort;
    this.lastActivity = Date.now();
    this.reading = true;
    const watchdog = window.setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) abort.abort();
    }, 5_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        this.lastActivity = Date.now();
        if (done) return "retry"; // dropped without the terminal marker
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          if (frame.data === null) continue;
          let event: RunEvent;
          try {
            event = JSON.parse(frame.data) as RunEvent;
          } catch {
            continue;
          }
          if (event.type === "stream_end") return "done";
          if (event.type === "stream_error") {
            if (event.status === 404) {
              const status = await this.checkStatus();
              return status === "active" || status === "unknown" ? "retry" : "done";
            }
            return event.retryable ? "retry" : "fatal";
          }
          this.failures = 0;
          this.deliver(event);
        }
      }
    } catch {
      return "retry";
    } finally {
      this.reading = false;
      window.clearInterval(watchdog);
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  private async pollLoop(): Promise<void> {
    this.setState("polling");
    while (!this.closed) {
      const status = await this.checkStatus();
      if (status === "terminal" || status === "gone") {
        this.close();
        this.setState("closed");
        return;
      }
      await this.sleep(POLL_MS);
    }
  }
}
