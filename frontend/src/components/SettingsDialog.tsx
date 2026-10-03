import type { Capabilities, Preferences, Status } from "../lib/types";
import { Modal } from "./ui";

interface Props {
  open: boolean;
  onClose: () => void;
  prefs: Preferences;
  onPrefs: (patch: Partial<Preferences>) => void;
  caps: Capabilities | null;
  status: Status | null;
  streaming: boolean;
}

function Yes({ v }: { v: boolean | string }) {
  const ok = Boolean(v);
  return <span className={ok ? "dash-yes" : "dash-no"}>{ok ? (typeof v === "string" ? v.replace(/_/g, " ") : "supported") : "not available"}</span>;
}

export function SettingsDialog({ open, onClose, prefs, onPrefs, caps, status, streaming }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="dash settings" description="Preferences are stored per Hermes profile in dash's plugin-data (UI only).">
      <fieldset className="dash-fieldset">
        <legend>Display</legend>
        <label className="dash-check">
          <input type="checkbox" checked={prefs.enter_to_send} onChange={(e) => onPrefs({ enter_to_send: e.target.checked })} />
          Enter sends (Shift+Enter for newline)
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={prefs.show_tool_details} onChange={(e) => onPrefs({ show_tool_details: e.target.checked })} />
          Expand tool details by default (developer view)
        </label>
        <label className="dash-check">
          <input type="checkbox" checked={prefs.show_reasoning} onChange={(e) => onPrefs({ show_reasoning: e.target.checked })} />
          Show reasoning text when the model exposes it
        </label>
        <label className="dash-check">
          <input
            type="checkbox"
            checked={prefs.density === "compact"}
            onChange={(e) => onPrefs({ density: e.target.checked ? "compact" : "comfortable" })}
          />
          Compact density
        </label>
      </fieldset>
      <fieldset className="dash-fieldset">
        <legend>Capabilities detected for this profile</legend>
        {caps ? (
          <table className="dash-caps">
            <tbody>
              <tr><th scope="row">Live streaming in this browser</th><td><Yes v={streaming} /></td></tr>
              <tr><th scope="row">Runs (native /v1/runs)</th><td><Yes v={caps.runs.submit} /></td></tr>
              <tr><th scope="row">Reconnect / resume</th><td><Yes v={caps.runs.resume_from_seq} /></td></tr>
              <tr><th scope="row">Idempotent submit</th><td><Yes v={caps.runs.idempotency_durable ? "durable" : caps.runs.idempotency} /></td></tr>
              <tr><th scope="row">Stop</th><td><Yes v={caps.runs.stop} /></td></tr>
              <tr><th scope="row">Approvals</th><td><Yes v={caps.runs.approval} /></td></tr>
              <tr><th scope="row">Tool activity</th><td><Yes v={caps.runs.tool_events} /></td></tr>
              <tr><th scope="row">Session fork</th><td><Yes v={caps.sessions.fork} /></td></tr>
              <tr><th scope="row">History search</th><td><Yes v={caps.sessions.search} /></td></tr>
              <tr><th scope="row">Image input</th><td><Yes v={caps.media.images} /></td></tr>
              <tr><th scope="row">File uploads</th><td><Yes v={caps.media.uploads} /></td></tr>
              <tr><th scope="row">Memory / SOUL view</th><td><Yes v={caps.hermes.memory_read || caps.hermes.soul_read} /></td></tr>
              <tr><th scope="row">MCP status</th><td><Yes v={caps.hermes.mcp_status} /></td></tr>
            </tbody>
          </table>
        ) : (
          <p className="dash-muted">Hermes capabilities unavailable (is the Hermes API server running?).</p>
        )}
      </fieldset>
      <p className="dash-small dash-muted">
        dash v{__DASH_VERSION__} · Hermes {status?.hermes.version ?? "unknown"} · profile {status?.profile ?? "?"} ({status?.target.routing ?? "?"} routing)
      </p>
    </Modal>
  );
}
