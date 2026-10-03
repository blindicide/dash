import { useEffect, useRef, useState } from "react";
import type { Capabilities, Session } from "../lib/types";
import { groupSessions, isMac, relativeTime, sessionTitle } from "../lib/util";
import { Btn, Modal } from "./ui";

interface Props {
  open: boolean;
  sessions: Session[];
  botChat: Session | null;
  currentId: string | null;
  caps: Capabilities | null;
  hasMore: boolean;
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onBotChat: () => void;
  onSearch: () => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onFork: (id: string) => void;
  onMore: () => void;
  onClose: () => void;
}

export function Sidebar(props: Props) {
  const { open, sessions, botChat, currentId, caps, hasMore, loading } = props;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Session | null>(null);
  const [title, setTitle] = useState("");
  const mod = isMac() ? "⌘" : "Ctrl";
  const visible = sessions.filter((s) => !s.is_bot_chat && !s.archived);
  const groups = groupSessions(visible);

  return (
    <nav id="dash-sidebar" className={`dash-sidebar${open ? " is-open" : ""}`} aria-label="Conversations">
      <div className="dash-sidebar__actions">
        <Btn onClick={props.onNew} title={`New chat (${mod}+Alt+N)`} className="dash-grow">
          + New chat
        </Btn>
        <Btn variant="outlined" onClick={props.onSearch} title={`Search (${mod}+K)`} aria-haspopup="dialog">
          Search
        </Btn>
      </div>
      {caps?.bot_chat !== false ? (
        <button
          type="button"
          className={`dash-botchat${botChat && botChat.id === currentId ? " is-active" : ""}`}
          onClick={props.onBotChat}
          aria-current={botChat && botChat.id === currentId ? "page" : undefined}
        >
          <span className="dash-botchat__icon" aria-hidden="true">◆</span>
          <span>
            <span className="dash-botchat__title">Bot Chat</span>
            <span className="dash-muted dash-small">
              {botChat ? "Canonical shared conversation" : "Not created yet — opens or creates it"}
            </span>
          </span>
        </button>
      ) : null}
      <div className="dash-sidebar__list" role="list">
        {groups.length === 0 && !loading ? <p className="dash-muted dash-pad">No conversations yet.</p> : null}
        {groups.map(([group, list]) => (
          <section key={group} aria-label={group} className="dash-group">
            <h3 className="dash-group__title">{group}</h3>
            <ul>
              {list.map((s) => (
                <li key={s.id} className={`dash-session${s.id === currentId ? " is-active" : ""}`}>
                  <button
                    type="button"
                    className="dash-session__open"
                    onClick={() => props.onOpen(s.id)}
                    aria-current={s.id === currentId ? "page" : undefined}
                  >
                    <span className="dash-session__title">
                      {s.pinned ? <span aria-label="pinned">📌 </span> : null}
                      {sessionTitle(s)}
                    </span>
                    <span className="dash-session__meta dash-muted">
                      {relativeTime(s.last_active ?? s.started_at)}
                      {s.source && s.source !== "api_server" ? ` · ${s.source}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="dash-session__more"
                    aria-label={`Actions for ${sessionTitle(s)}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === s.id}
                    onClick={() => setMenuFor(menuFor === s.id ? null : s.id)}
                  >
                    ⋯
                  </button>
                  {menuFor === s.id ? (
                    <SessionMenu
                      onClose={() => setMenuFor(null)}
                      items={[
                        caps?.sessions.rename !== false && {
                          label: "Rename",
                          run: () => {
                            setTitle(s.title || "");
                            setRenaming(s);
                          },
                        },
                        caps?.sessions.pin_archive !== false && { label: s.pinned ? "Unpin" : "Pin", run: () => props.onPin(s.id, !s.pinned) },
                        caps?.sessions.fork && { label: "Fork / branch", run: () => props.onFork(s.id) },
                        caps?.sessions.pin_archive !== false && { label: "Archive", run: () => props.onArchive(s.id) },
                        caps?.sessions.delete !== false && { label: "Delete…", danger: true, run: () => setConfirmDelete(s) },
                      ]}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {hasMore ? (
          <div className="dash-pad">
            <Btn variant="ghost" size="sm" onClick={props.onMore} disabled={loading}>
              {loading ? "Loading…" : "Load more"}
            </Btn>
          </div>
        ) : null}
      </div>
      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename conversation"
        footer={
          <>
            <Btn variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Btn>
            <Btn
              onClick={() => {
                if (renaming && title.trim()) props.onRename(renaming.id, title.trim());
                setRenaming(null);
              }}
              disabled={!title.trim()}
            >
              Save
            </Btn>
          </>
        }
      >
        <label className="dash-field">
          <span>Title</span>
          <input
            className="dash-input"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renaming && title.trim()) {
                props.onRename(renaming.id, title.trim());
                setRenaming(null);
              }
            }}
          />
        </label>
      </Modal>
      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete conversation?"
        description="This permanently deletes the conversation from Hermes for every client (CLI, Telegram, Dashboard, dash)."
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Btn>
            <Btn
              variant="destructive"
              onClick={() => {
                if (confirmDelete) props.onDelete(confirmDelete.id);
                setConfirmDelete(null);
              }}
            >
              Delete
            </Btn>
          </>
        }
      >
        <p>{confirmDelete ? sessionTitle(confirmDelete) : ""}</p>
      </Modal>
    </nav>
  );
}

type MenuItem = { label: string; run: () => void; danger?: boolean } | false | undefined | null;

function SessionMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  const real = items.filter(Boolean) as { label: string; run: () => void; danger?: boolean }[];
  return (
    <ul
      ref={ref}
      className="dash-menu"
      role="menu"
      onKeyDown={(e) => {
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") onClose();
        if (e.key === "ArrowDown") {
          e.preventDefault();
          buttons[(idx + 1) % buttons.length]?.focus();
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          buttons[(idx - 1 + buttons.length) % buttons.length]?.focus();
        }
      }}
    >
      {real.map((item) => (
        <li key={item.label} role="none">
          <button
            type="button"
            role="menuitem"
            className={item.danger ? "is-danger" : undefined}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
