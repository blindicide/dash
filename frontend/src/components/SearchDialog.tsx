import { useEffect, useRef, useState } from "react";
import { api, DashApiError } from "../lib/api";
import type { Session } from "../lib/types";
import { relativeTime, sessionTitle } from "../lib/util";
import { Modal } from "./ui";

interface Props {
  open: boolean;
  profile: string | null;
  onClose: () => void;
  onPick: (id: string) => void;
}

/** Historical session search (titles/previews via the BFF). Distinct from the agent's own
 * session_search tool — this never runs the agent. */
export function SearchDialog({ open, profile, onClose, onPick }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Session[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mounted fresh each time it opens (see DashApp), so no reset effect is needed.
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  const needle = q.trim();
  useEffect(() => {
    if (!open || !needle) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      setState("loading");
      try {
        const res = await api.search(profile, needle, ctrl.signal);
        setResults(res.sessions);
        setActive(0);
        setNote(res.truncated ? `Searched the ${res.scanned} most recent conversations.` : `${res.sessions.length} match(es).`);
        setState("done");
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setNote(e instanceof DashApiError ? e.message : "Search failed.");
        setState("error");
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [needle, open, profile]);
  const shown = needle ? results : [];

  const pick = (s: Session | undefined) => {
    if (!s) return;
    onPick(s.id);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Search conversations" description="Matches conversation titles and previews in Hermes.">
      <input
        ref={inputRef}
        className="dash-input"
        type="search"
        placeholder="Search history…"
        aria-label="Search conversations"
        aria-controls="dash-search-results"
        aria-activedescendant={shown[active] ? `dash-sr-${shown[active]!.id}` : undefined}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(shown[active]);
          }
        }}
      />
      <p className="dash-muted dash-small" role="status" aria-live="polite">
        {!needle ? "" : state === "loading" ? "Searching…" : note}
      </p>
      <ul id="dash-search-results" className="dash-search-results" role="listbox" aria-label="Search results">
        {shown.map((s, i) => (
          <li key={s.id} id={`dash-sr-${s.id}`} role="option" aria-selected={i === active}>
            <button type="button" className={i === active ? "is-active" : undefined} onClick={() => pick(s)}>
              <span className="dash-session__title">{sessionTitle(s)}</span>
              <span className="dash-muted dash-small">
                {relativeTime(s.last_active ?? s.started_at)}
                {s.preview ? ` · ${s.preview.slice(0, 80)}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
