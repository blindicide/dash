import type { StreamState } from "../lib/stream";
import type { ProfileItem, Status } from "../lib/types";
import { Badge, Btn } from "./ui";

interface Props {
  status: Status | null;
  profiles: ProfileItem[];
  profile: string;
  online: boolean;
  streamState: StreamState | null;
  onProfile: (name: string) => void;
  onMenu: () => void;
  onSettings: () => void;
  onHermes: () => void;
  sidebarOpen: boolean;
}

function connection(status: Status | null, online: boolean, stream: StreamState | null) {
  if (!online) return { tone: "destructive" as const, label: "Offline" };
  if (!status) return { tone: "secondary" as const, label: "Connecting…" };
  if (!status.hermes.reachable) return { tone: "destructive" as const, label: "Hermes unavailable" };
  if (stream === "reconnecting") return { tone: "warning" as const, label: "Reconnecting…" };
  if (stream === "polling") return { tone: "warning" as const, label: "Polling" };
  return { tone: "success" as const, label: "Connected" };
}

export function Header({ status, profiles, profile, online, streamState, onProfile, onMenu, onSettings, onHermes, sidebarOpen }: Props) {
  const conn = connection(status, online, streamState);
  const model = status?.hermes.model;
  return (
    <header className="dash-header">
      <Btn
        variant="ghost"
        size="icon"
        className="dash-header__menu"
        onClick={onMenu}
        aria-label={sidebarOpen ? "Close conversation list" : "Open conversation list"}
        aria-expanded={sidebarOpen}
        aria-controls="dash-sidebar"
      >
        <span aria-hidden="true">☰</span>
      </Btn>
      <div className="dash-brand" aria-label={`dash version ${__DASH_VERSION__}`}>
        <span className="dash-brand__symbol" aria-hidden="true">\</span>
        <span className="dash-brand__name">dash</span>
        <span className="dash-brand__version">v{__DASH_VERSION__}</span>
      </div>
      <div className="dash-header__ctx">
        {profiles.length > 1 ? (
          <label className="dash-select">
            <span className="dash-sr">Hermes profile</span>
            <select value={profile} onChange={(e) => onProfile(e.target.value)} aria-label="Hermes profile">
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {p.is_launch ? " (dashboard)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Badge tone="outline" title="Hermes profile">
            {profile}
          </Badge>
        )}
        {model ? (
          <Badge tone="secondary" className="dash-header__model" title="Model reported by the Hermes API server">
            {model}
          </Badge>
        ) : null}
      </div>
      <div className="dash-header__right">
        <span className={`dash-conn dash-conn--${conn.tone}`} role="status" aria-live="polite">
          <span className="dash-conn__dot" aria-hidden="true" />
          <span className="dash-conn__label">{conn.label}</span>
        </span>
        <Btn variant="ghost" size="sm" onClick={onHermes} aria-haspopup="dialog">
          Hermes
        </Btn>
        <Btn variant="ghost" size="sm" onClick={onSettings} aria-haspopup="dialog">
          Settings
        </Btn>
      </div>
    </header>
  );
}
