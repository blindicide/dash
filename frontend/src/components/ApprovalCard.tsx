import type { ApprovalCard as Card } from "../lib/runState";
import type { ApprovalChoice } from "../lib/types";
import { Btn } from "./ui";

const CHOICE_LABEL: Record<ApprovalChoice, string> = {
  once: "Approve once",
  session: "Approve for this session",
  always: "Always approve this pattern",
  deny: "Deny",
};

/** Presents exactly what Hermes supplied and waits for an explicit human decision.
 * dash never approves anything automatically. */
export function ApprovalCard({ card, onRespond }: { card: Card; onRespond: (choice: ApprovalChoice) => void }) {
  const busy = card.state === "submitting";
  const choices = card.choices.filter((c) => c !== "deny");
  return (
    <section
      className={`dash-approval dash-approval--${card.state}`}
      role={card.state === "pending" ? "alertdialog" : "region"}
      aria-label="Approval required"
      aria-describedby={`${card.id}-desc`}
    >
      <header className="dash-approval__head">
        <span aria-hidden="true">⚠</span>
        <strong>{card.state === "pending" || busy ? "Hermes is asking for approval" : "Approval"}</strong>
        {card.patternKey ? <span className="dash-badge dash-badge--warning">{card.patternKey}</span> : null}
      </header>
      <div id={`${card.id}-desc`}>
        {card.description ? <p>{card.description}</p> : null}
        {card.command ? (
          <pre className="dash-pre" tabIndex={0} aria-label="Requested action">
            {card.command}
          </pre>
        ) : null}
        {card.smartDenied ? <p className="dash-small dash-muted">Hermes' safety review flagged this action; only a one-time approval is offered.</p> : null}
      </div>
      {card.state === "pending" || busy ? (
        <div className="dash-approval__actions">
          {choices.map((c) => (
            <Btn key={c} variant={c === "once" ? "primary" : "outlined"} size="sm" disabled={busy} onClick={() => onRespond(c)}>
              {CHOICE_LABEL[c]}
            </Btn>
          ))}
          <Btn variant="destructive" size="sm" disabled={busy} onClick={() => onRespond("deny")}>
            {CHOICE_LABEL.deny}
          </Btn>
          {busy ? <span className="dash-small dash-muted" role="status">Sending decision…</span> : null}
        </div>
      ) : (
        <p className="dash-small dash-muted" role="status">
          {card.state === "resolved"
            ? card.choice === "deny"
              ? "Denied."
              : `Approved (${card.choice}).`
            : "No longer pending (the run ended or another client answered)."}
        </p>
      )}
    </section>
  );
}
