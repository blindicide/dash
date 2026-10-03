import { Markdown } from "../lib/markdown";
import type { RunView } from "../lib/runState";
import type { ApprovalChoice } from "../lib/types";
import { ApprovalCard } from "./ApprovalCard";
import { ToolCard } from "./ToolCard";

interface Props {
  run: RunView;
  showReasoning: boolean;
  showToolDetails: boolean;
  onApproval: (cardId: string, choice: ApprovalChoice) => void;
}

const STATUS_TEXT: Record<string, string> = {
  submitting: "Sending…",
  queued: "Queued in Hermes…",
  started: "Starting…",
  running: "Working…",
  waiting_for_approval: "Waiting for your approval",
  stopping: "Stopping…",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

/** The in-flight turn, rendered from structured Hermes run events. Only activity Hermes
 * actually exposed is shown — dash never fabricates "thinking". */
export function LiveRun({ run, showReasoning, showToolDetails, onApproval }: Props) {
  const active = !["completed", "failed", "cancelled", "interrupted"].includes(run.status);
  return (
    <div className="dash-live" aria-busy={active}>
      {run.userText || run.userImages.length ? (
        <article className="dash-msg dash-msg--user" aria-label="You">
          <div className="dash-bubble">
            {run.userImages.length ? (
              <div className="dash-msg__images">
                {run.userImages.map((src, i) => (
                  <img key={i} src={src} alt={`Attached image ${i + 1}`} />
                ))}
              </div>
            ) : null}
            {run.userText ? <Markdown text={run.userText} /> : null}
          </div>
        </article>
      ) : null}
      <article className="dash-msg dash-msg--assistant" aria-label="Hermes (live)">
        {run.timeline.map((item) => {
          switch (item.kind) {
            case "text":
              return (
                <div key={item.id} className="dash-assistant">
                  <Markdown text={item.text} />
                </div>
              );
            case "commentary":
              return (
                <p key={item.id} className="dash-commentary">
                  {item.text}
                </p>
              );
            case "reasoning":
              return showReasoning ? (
                <details key={item.id} className="dash-reasoning">
                  <summary>Reasoning exposed by the model</summary>
                  <Markdown text={item.text} />
                </details>
              ) : null;
            case "tool": {
              const t = run.tools[item.id];
              return t ? (
                <ToolCard
                  key={item.id}
                  tool={t.tool}
                  status={t.status}
                  preview={t.preview}
                  result={t.result}
                  duration={t.duration}
                  showDetails={showToolDetails}
                />
              ) : null;
            }
            case "approval": {
              const a = run.approvals[item.id];
              return a ? <ApprovalCard key={item.id} card={a} onRespond={(c) => onApproval(a.id, c)} /> : null;
            }
            case "subagent":
              return (
                <p key={item.id} className="dash-activity dash-small">
                  Subagent {item.phase}: {item.text}
                </p>
              );
            case "notice":
              return (
                <p key={item.id} className="dash-activity dash-small" role="note">
                  {item.text}
                </p>
              );
            default:
              return null;
          }
        })}
        <div className={`dash-runstatus dash-runstatus--${run.status}`} role="status" aria-live="polite">
          {active ? <span className="dash-spinner" aria-hidden="true" /> : null}
          <span>{STATUS_TEXT[run.status] ?? run.status}</span>
          {run.error ? <span className="dash-runstatus__err">: {run.error}</span> : null}
          {run.runId ? <span className="dash-runstatus__id dash-muted">{run.runId.slice(0, 12)}</span> : null}
        </div>
      </article>
    </div>
  );
}
