import { useId, useState } from "react";
import type { ToolStatus } from "../lib/runState";

const LABEL: Record<ToolStatus, string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  denied: "Denied",
  stopped: "Stopped",
};

interface Props {
  tool: string;
  status: ToolStatus;
  preview?: string;
  args?: string;
  result?: string;
  duration?: number;
  showDetails: boolean;
}

/** Concise collapsed card; the expandable developer details (open by default when the
 * "show tool details" preference is on) show only what Hermes already exposed (redacted
 * previews / recorded arguments) — no hidden data is fetched. */
export function ToolCard({ tool, status, preview, args, result, duration, showDetails }: Props) {
  const [open, setOpen] = useState(showDetails);
  const id = useId();
  const hasDetail = Boolean(args || result || (preview && preview.length > 80));
  return (
    <div className={`dash-tool dash-tool--${status}`}>
      <div className="dash-tool__row">
        <span className="dash-tool__icon" aria-hidden="true">
          {status === "running" ? <span className="dash-spinner" /> : status === "completed" ? "✓" : status === "failed" ? "✕" : status === "denied" ? "⊘" : "■"}
        </span>
        <span className="dash-tool__name">{tool}</span>
        <span className="dash-tool__status">
          {LABEL[status]}
          {typeof duration === "number" ? ` · ${duration.toFixed(1)}s` : ""}
        </span>
        {preview ? <span className="dash-tool__preview">{preview.split("\n")[0]?.slice(0, 120)}</span> : null}
        {hasDetail ? (
          <button
            type="button"
            className="dash-linkbtn dash-tool__toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide" : "Details"}
          </button>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="dash-tool__detail">
          {preview ? <DetailBlock label="Input" text={preview} /> : null}
          {args ? <DetailBlock label="Arguments" text={args} /> : null}
          {result ? <DetailBlock label="Result (preview)" text={result} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="dash-small dash-muted">{label}</div>
      <pre className="dash-pre" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}
