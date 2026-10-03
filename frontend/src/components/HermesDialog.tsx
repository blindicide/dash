import { useEffect, useState } from "react";
import { api, DashApiError } from "../lib/api";
import type { Capabilities, Status } from "../lib/types";
import { Modal } from "./ui";

interface Props {
  open: boolean;
  onClose: () => void;
  profile: string | null;
  caps: Capabilities | null;
  status: Status | null;
}

type Skill = { name: string; description?: string; category?: string; enabled?: boolean };
type Toolset = { name: string; label?: string; description?: string; enabled: boolean; configured: boolean; tools: string[] };

/** Read-only view of what the Hermes API server exposes about this profile. Editing model,
 * skills, SOUL or memory stays in the official Hermes surfaces (no private internals here). */
export function HermesDialog({ open, onClose, profile, caps, status }: Props) {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [toolsets, setToolsets] = useState<Toolset[] | null>(null);
  const [model, setModel] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const fail = (e: unknown) => live && setError(e instanceof DashApiError ? e.message : "Could not load Hermes details.");
    if (caps?.hermes.skills) api.skills(profile).then((r) => live && setSkills(r.skills), fail);
    if (caps?.hermes.toolsets) api.toolsets(profile).then((r) => live && setToolsets(r.toolsets), fail);
    if (caps?.hermes.model_options) api.models(profile).then((r) => live && setModel(r.model_options), fail);
    return () => {
      live = false;
    };
  }, [open, profile, caps]);

  const current = (model as { current?: { model?: string; provider?: string } } | null)?.current;
  return (
    <Modal open={open} onClose={onClose} title="Hermes context" description="Read-only. Change these in Hermes itself (CLI, Dashboard config pages).">
      {error ? <p className="dash-error" role="alert">{error}</p> : null}
      <section className="dash-section">
        <h3>Agent</h3>
        <p>
          Hermes {status?.hermes.version ?? "?"} · API model alias <code>{status?.hermes.model ?? "?"}</code>
          {current?.model ? (
            <>
              {" "}
              · configured <code>{current.provider ? `${current.provider}/` : ""}{current.model}</code>
            </>
          ) : null}
        </p>
        <p className="dash-small dash-muted">
          Model/provider switching, SOUL, memory and MCP management are not exposed by the Hermes API server
          {caps ? "" : " (capabilities unknown)"}; dash therefore shows them as unavailable rather than reading private files.
        </p>
      </section>
      {toolsets ? (
        <section className="dash-section">
          <h3>Toolsets</h3>
          <ul className="dash-kv">
            {toolsets.map((t) => (
              <li key={t.name}>
                <strong>{t.label || t.name}</strong>{" "}
                <span className={t.enabled ? "dash-yes" : "dash-no"}>{t.enabled ? "enabled" : "disabled"}</span>
                {t.enabled && !t.configured ? <span className="dash-no"> · needs setup</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {skills ? (
        <section className="dash-section">
          <h3>Skills ({skills.length})</h3>
          <ul className="dash-kv">
            {skills.slice(0, 200).map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>
                {s.description ? <span className="dash-muted"> — {s.description.slice(0, 140)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Modal>
  );
}
