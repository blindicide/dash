import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDash } from "../hooks/useDash";
import { supportsStreaming } from "../lib/api";
import { isActive } from "../lib/runState";
import { Composer } from "./Composer";
import { Conversation } from "./Conversation";
import { Header } from "./Header";
import { HermesDialog } from "./HermesDialog";
import { SearchDialog } from "./SearchDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { Btn } from "./ui";

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

/**
 * Fill the visible space of the host's scroll container (the Dashboard renders plugin pages
 * inside a scrollable <main>, below host chrome such as banners) so the composer stays on
 * screen on every viewport. Re-measures when the container or viewport resizes, e.g. when
 * a host banner is dismissed or the mobile keyboard opens.
 */
function useFillHeight(ref: React.RefObject<HTMLDivElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const container = scrollParent(el);
    const apply = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const bottom = container ? Math.min(container.getBoundingClientRect().bottom, vh) : vh;
      // Ancestors between us and the container may add bottom padding (safe-area etc.).
      let below = 0;
      for (let p = el.parentElement; p && p !== container; p = p.parentElement) {
        below += parseFloat(getComputedStyle(p).paddingBottom) || 0;
      }
      const scrolled = container?.scrollTop ?? 0;
      const top = el.getBoundingClientRect().top + scrolled;
      const containerTop = container ? container.getBoundingClientRect().top : 0;
      const offset = top - containerTop;
      const available = bottom - containerTop - offset - below;
      el.style.height = `${Math.max(200, Math.floor(available))}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    window.visualViewport?.addEventListener("resize", apply);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(container ?? document.body);
    if (container?.firstElementChild) ro?.observe(container.firstElementChild);
    return () => {
      window.removeEventListener("resize", apply);
      window.visualViewport?.removeEventListener("resize", apply);
      ro?.disconnect();
    };
  }, [ref, ready]);
}

export function DashApp() {
  const d = useDash();
  const root = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hermesOpen, setHermesOpen] = useState(false);
  useFillHeight(root, !d.booting && !d.bootError);

  const closeOnMobile = useCallback(() => setSidebarOpen(false), []);

  // Shortcuts: Ctrl/Cmd+K (search) and Ctrl/Cmd+Alt+N (new chat). Plain Ctrl/Cmd+N belongs to
  // the browser (new window) and is deliberately never intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === "Escape" && sidebarOpen) setSidebarOpen(false);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((k === "n" || e.code === "KeyN") && e.altKey && !e.shiftKey) {
        e.preventDefault();
        d.newChat();
        closeOnMobile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, sidebarOpen, closeOnMobile]);

  if (d.booting) {
    return (
      <div className="dash-root dash-center" role="status">
        <span className="dash-spinner" aria-hidden="true" /> Loading dash…
      </div>
    );
  }
  if (d.bootError) {
    return (
      <div className="dash-root dash-center">
        <div role="alert" className="dash-fatal">
          <h2>
            <span aria-hidden="true">\</span> dash could not start
          </h2>
          <p>{d.bootError}</p>
          <p className="dash-muted dash-small">
            Check that the dash plugin is enabled (<code>hermes plugins enable dash</code>) and the Dashboard was
            restarted so its backend routes are mounted.
          </p>
          <Btn onClick={() => window.location.reload()}>Reload</Btn>
        </div>
      </div>
    );
  }

  const active = isActive(d.run);
  const caps = d.caps;
  return (
    <div ref={root} className={`dash-root dash-density-${d.prefs.density}`} data-dash-version={__DASH_VERSION__}>
      <Header
        status={d.status}
        profiles={d.profiles}
        profile={d.profile}
        online={d.online}
        streamState={d.streamState}
        onProfile={(name) => void d.switchProfile(name)}
        onMenu={() => setSidebarOpen((o) => !o)}
        onSettings={() => setSettingsOpen(true)}
        onHermes={() => setHermesOpen(true)}
        sidebarOpen={sidebarOpen}
      />
      {d.notice ? (
        <div className={`dash-notice dash-notice--${d.notice.kind}`} role={d.notice.kind === "error" ? "alert" : "status"}>
          <span>{d.notice.text}</span>
          {d.notice.code === "dashboard_auth_expired" ? (
            <Btn size="sm" onClick={() => window.location.reload()}>
              Reload
            </Btn>
          ) : null}
          <button type="button" className="dash-linkbtn" onClick={() => d.setNotice(null)} aria-label="Dismiss message">
            ×
          </button>
        </div>
      ) : null}
      <div className="dash-body">
        {sidebarOpen ? <div className="dash-scrim" onClick={closeOnMobile} aria-hidden="true" /> : null}
        <Sidebar
          open={sidebarOpen}
          sessions={d.sessions}
          botChat={d.botChat}
          currentId={d.currentId}
          caps={caps}
          hasMore={d.sessionsHasMore}
          loading={d.sessionsLoading}
          onOpen={(id) => {
            void d.openSession(id);
            closeOnMobile();
          }}
          onNew={() => {
            d.newChat();
            closeOnMobile();
          }}
          onBotChat={() => {
            void d.openBotChat();
            closeOnMobile();
          }}
          onSearch={() => setSearchOpen(true)}
          onRename={(id, t) => void d.renameSession(id, t)}
          onPin={(id, p) => void d.setPinned(id, p)}
          onArchive={(id) => void d.setArchived(id, true)}
          onDelete={(id) => void d.deleteSession(id)}
          onFork={(id) => void d.forkSession(id)}
          onMore={() => void d.loadMoreSessions()}
          onClose={closeOnMobile}
        />
        <main className="dash-main" aria-label="Conversation">
          <Conversation
            session={d.current}
            sessionId={d.currentId}
            messages={d.messages}
            loading={d.messagesLoading}
            run={d.run}
            showReasoning={d.prefs.show_reasoning}
            showToolDetails={d.prefs.show_tool_details}
            onApproval={(id, c) => void d.respondApproval(id, c)}
            onBotChat={() => void d.openBotChat()}
          />
          {caps && !caps.runs.submit ? (
            <p className="dash-notice dash-notice--warning" role="status">
              This Hermes API server does not offer native runs; sending is unavailable in dash.
            </p>
          ) : null}
          <Composer
            profileName={d.profile}
            profileQs={d.pqs}
            sessionId={d.currentId}
            caps={caps}
            busy={active || !caps?.runs.submit}
            sending={d.sending}
            canStop={active && Boolean(d.run?.runId) && Boolean(caps?.runs.stop) && d.run?.status !== "stopping"}
            online={d.online}
            enterToSend={d.prefs.enter_to_send}
            onSend={d.send}
            onStop={() => void d.stop()}
            onError={(text) => d.setNotice({ kind: "warning", text })}
          />
        </main>
      </div>
      {searchOpen ? (
        <SearchDialog open profile={d.pqs} onClose={() => setSearchOpen(false)} onPick={(id) => void d.openSession(id)} />
      ) : null}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={d.prefs}
        onPrefs={(p) => void d.updatePrefs(p)}
        caps={caps}
        status={d.status}
        streaming={supportsStreaming()}
      />
      {hermesOpen ? (
        <HermesDialog open onClose={() => setHermesOpen(false)} profile={d.pqs} caps={caps} status={d.status} />
      ) : null}
    </div>
  );
}
