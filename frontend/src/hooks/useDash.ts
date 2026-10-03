/**
 * Central controller. Holds only view state; Hermes (via the BFF) is the source of truth.
 *
 * Profile isolation: every async continuation checks a generation counter, so results from a
 * previous profile/session can never land in the current view. Switching profile closes the
 * run subscription (the Hermes run keeps going), clears all session state, and restores that
 * profile's last dash session from the BFF's per-profile plugin-data store.
 *
 * Send is idempotent: the client_request_id is persisted (tab-scoped) before the request and
 * reused on retry, so Hermes replays instead of starting a duplicate run. After a reload, dash
 * only *re-attaches* to a run Hermes reports as active — it never resends.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, DashApiError } from "../lib/api";
import { applyEvent, isActive, markApprovalPending, markApprovalSubmitting, newRun, TERMINAL, type RunView } from "../lib/runState";
import { RunStream, type StreamState } from "../lib/stream";
import { local, pendingKey, readPending, tab, type PendingSubmission } from "../lib/storage";
import type {
  ApprovalChoice,
  Capabilities,
  ImageAttachment,
  Message,
  Preferences,
  ProfileItem,
  Session,
  Status,
  UploadRef,
} from "../lib/types";
import { uuid } from "../lib/util";

export type Notice = { kind: "error" | "info" | "warning"; text: string; code?: string; retry?: () => void } | null;

const DEFAULT_PREFS: Preferences = {
  density: "comfortable",
  show_reasoning: false,
  show_tool_details: false,
  enter_to_send: true,
};

export interface DashController {
  booting: boolean;
  bootError: string | null;
  profiles: ProfileItem[];
  launchProfile: string;
  profile: string;
  status: Status | null;
  caps: Capabilities | null;
  sessions: Session[];
  sessionsHasMore: boolean;
  sessionsLoading: boolean;
  botChat: Session | null;
  currentId: string | null;
  current: Session | null;
  messages: Message[];
  messagesLoading: boolean;
  run: RunView | null;
  streamState: StreamState | null;
  prefs: Preferences;
  notice: Notice;
  online: boolean;
  sending: boolean;
  setNotice: (n: Notice) => void;
  switchProfile: (name: string) => Promise<void>;
  openSession: (id: string | null) => Promise<void>;
  newChat: () => void;
  openBotChat: () => Promise<void>;
  send: (text: string, images: ImageAttachment[], uploads: UploadRef[]) => Promise<boolean>;
  stop: () => Promise<void>;
  respondApproval: (cardId: string, choice: ApprovalChoice) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  updatePrefs: (patch: Partial<Preferences>) => Promise<void>;
  pqs: string | null; // the ?profile= value for the current profile (null = launch profile)
}

function describe(e: unknown): Notice {
  if (e instanceof DashApiError) {
    if (e.kind === "auth") return { kind: "error", text: e.message, code: e.code };
    if (e.kind === "network") return { kind: "error", text: "Network disconnected. Your text is kept; retry when back online.", code: e.code };
    if (e.code === "hermes_unavailable") return { kind: "error", text: "Hermes is unavailable right now. Check that the Hermes gateway API server is running.", code: e.code };
    if (e.code === "hermes_auth_failed") return { kind: "error", text: e.message, code: e.code };
    if (e.code === "unsupported_capability") return { kind: "warning", text: e.message, code: e.code };
    return { kind: "error", text: e.message, code: e.code };
  }
  return { kind: "error", text: "Something went wrong." };
}

export function useDash(): DashController {
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [launchProfile, setLaunchProfile] = useState("default");
  const [profile, setProfile] = useState("default");
  const [status, setStatus] = useState<Status | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [botChat, setBotChat] = useState<Session | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [current, setCurrent] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [streamState, setStreamState] = useState<StreamState | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [notice, setNotice] = useState<Notice>(null);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [sending, setSending] = useState(false);

  const gen = useRef(0); // bumps on profile/session switch
  const streamRef = useRef<RunStream | null>(null);
  const runRef = useRef<RunView | null>(null);
  const profileRef = useRef(profile);
  const launchRef = useRef(launchProfile);
  const currentRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    runRef.current = run;
    profileRef.current = profile;
    launchRef.current = launchProfile;
    currentRef.current = currentId;
  });

  const pqsFor = useCallback((name: string) => (name === launchRef.current ? null : name), []);
  const pqs = useMemo(() => (profile === launchProfile ? null : profile), [profile, launchProfile]);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    setStreamState(null);
  }, []);

  const loadSessions = useCallback(
    async (p: string | null, myGen: number, offset = 0) => {
      setSessionsLoading(true);
      try {
        const res = await api.sessions(p, 50, offset);
        if (gen.current !== myGen && offset === 0) return;
        setSessions((prev) => (offset === 0 ? res.sessions : [...prev, ...res.sessions.filter((s) => !prev.some((x) => x.id === s.id))]));
        setSessionsHasMore(res.has_more);
      } catch (e) {
        if (gen.current === myGen) setNotice(describe(e));
      } finally {
        setSessionsLoading(false);
      }
    },
    [],
  );

  const refreshBotChat = useCallback(async (p: string | null) => {
    try {
      setBotChat((await api.botChat(p)).session);
    } catch {
      setBotChat(null);
    }
  }, []);

  const reloadMessages = useCallback(async (p: string | null, sid: string, myGen: number) => {
    setMessagesLoading(true);
    try {
      const res = await api.messages(p, sid);
      if (gen.current !== myGen || currentRef.current !== sid) return;
      setMessages(res.messages);
    } catch (e) {
      if (gen.current === myGen) setNotice(describe(e));
    } finally {
      if (gen.current === myGen) setMessagesLoading(false);
    }
  }, []);

  const finishRun = useCallback(
    async (p: string | null, view: RunView, myGen: number) => {
    tab.set(pendingKey(profileRef.current, view.sessionId), null);
    if (view.status === "failed") {
      setNotice({ kind: "error", text: view.error ? `Run failed: ${view.error}` : "The run failed." });
    } else if (view.status === "interrupted") {
      setNotice({ kind: "warning", text: "The run was interrupted (Hermes restarted or the run expired)." });
    }
    await reloadMessages(p, view.sessionId, myGen);
    if (gen.current !== myGen) return;
    // Keep the settled live view only if the transcript did not load (e.g. offline).
    setRun((prev) => (prev && prev.runId === view.runId && TERMINAL.has(prev.status) ? null : prev));
    streamRef.current?.close();
    streamRef.current = null;
    void loadSessions(p, myGen);
      },
    [loadSessions, reloadMessages],
  );

  const attachRun = useCallback(
    (p: string | null, runId: string, view: RunView, myGen: number) => {
      streamRef.current?.close();
      const stream = new RunStream({
        profile: p,
        runId,
        lastSeq: view.lastSeq,
        onEvent: (event) => {
          if (gen.current !== myGen) return;
          setRun((prev) => {
            if (!prev || prev.runId !== runId) return prev;
            const next = applyEvent(prev, event);
            if (TERMINAL.has(next.status) && !TERMINAL.has(prev.status)) {
              // Canonical transcript comes from Hermes once the run settles.
              void finishRun(p, next, myGen);
            }
            return next;
          });
        },
        onState: (state, detail) => {
          if (gen.current !== myGen) return;
          setStreamState(state);
          if (state === "failed" && detail === "dashboard_auth_expired") {
            setNotice({ kind: "error", text: "Your Dashboard session expired. Reload the page to sign in again.", code: detail });
          }
          if (state === "failed" && detail === "run_not_found") {
            void finishRun(p, { ...view, status: "interrupted" }, myGen);
          }
        },
      });
      streamRef.current = stream;
      stream.start();
    },
    [finishRun],
  );


  const openSessionFor = useCallback(
    async (pName: string, id: string | null, myGen: number) => {
      const p = pqsFor(pName);
      closeStream();
      setRun(null);
      setMessages([]);
      setCurrentId(id);
      currentRef.current = id;
      setCurrent(id ? (sessions.find((s) => s.id === id) ?? null) : null);
      if (!id) return;
      void api.setLastSession(p, id).catch(() => undefined);
      setMessagesLoading(true);
      try {
        const [sess, msgs, active] = await Promise.all([
          api.session(p, id),
          api.messages(p, id),
          api.activeRun(p, id).catch(() => ({ run: null }) as { run: null }),
        ]);
        if (gen.current !== myGen) return;
        setCurrent(sess.session);
        setMessages(msgs.messages);
        const activeRun = active.run;
        if (activeRun && !activeRun.terminal) {
          // Re-attach only. lastSeq=null replays Hermes' retained backlog for this run, which
          // rebuilds the live view (including a still-pending approval) without resending.
          const view: RunView = { ...newRun(id, ""), runId: activeRun.run_id, status: "running" };
          setRun(view);
          attachRun(p, activeRun.run_id, view, myGen);
        }
      } catch (e) {
        if (gen.current !== myGen) return;
        if (e instanceof DashApiError && e.status === 404) {
          setCurrentId(null);
          setCurrent(null);
          void api.setLastSession(p, null).catch(() => undefined);
          setNotice({ kind: "info", text: "That conversation no longer exists in Hermes." });
        } else {
          setNotice(describe(e));
        }
      } finally {
        if (gen.current === myGen) setMessagesLoading(false);
      }
    },
    [attachRun, closeStream, pqsFor, sessions],
  );

  const loadProfile = useCallback(
    async (name: string) => {
      const myGen = ++gen.current;
      closeStream();
      setProfile(name);
      profileRef.current = name;
      local.set("profile", name);
      setStatus(null);
      setCaps(null);
      setSessions([]);
      setBotChat(null);
      setCurrentId(null);
      setCurrent(null);
      setMessages([]);
      setRun(null);
      setNotice(null);
      const p = pqsFor(name);
      try {
        const [st, cp, state] = await Promise.all([
          api.status(p),
          api.capabilities(p).catch((e) => {
            throw e;
          }),
          api.state(p),
        ]);
        if (gen.current !== myGen) return;
        setStatus(st);
        setCaps(cp.capabilities);
        setPrefs({ ...DEFAULT_PREFS, ...state.preferences });
        void loadSessions(p, myGen);
        void refreshBotChat(p);
        if (state.last_session_id) await openSessionFor(name, state.last_session_id, myGen);
      } catch (e) {
        if (gen.current !== myGen) return;
        // Status still renders even when Hermes is down.
        try {
          setStatus(await api.status(p));
        } catch {
          /* BFF unreachable too */
        }
        setNotice(describe(e));
      }
    },
    [closeStream, loadSessions, openSessionFor, pqsFor, refreshBotChat],
  );

  // Boot ---------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.profiles();
        if (cancelled) return;
        setProfiles(res.profiles);
        setLaunchProfile(res.launch_profile);
        launchRef.current = res.launch_profile;
        const saved = local.get("profile");
        const initial = saved && res.profiles.some((p) => p.name === saved) ? saved : res.launch_profile;
        setBooting(false);
        await loadProfile(initial);
      } catch (e) {
        if (cancelled) return;
        setBooting(false);
        setBootError(describe(e)?.text ?? "dash backend unavailable");
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Connectivity + background refresh (another Hermes client may have added messages).
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    const refresh = () => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      const sid = currentRef.current;
      const p = pqsFor(profileRef.current);
      const myGen = gen.current;
      if (sid && !isActive(runRef.current)) void reloadMessages(p, sid, myGen);
      void loadSessions(p, myGen);
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [loadSessions, pqsFor, reloadMessages]);

  // Actions --------------------------------------------------------------------------------
  const switchProfile = useCallback(
    async (name: string) => {
      if (name === profileRef.current) return;
      await loadProfile(name);
    },
    [loadProfile],
  );

  const openSession = useCallback(
    async (id: string | null) => {
      const myGen = ++gen.current;
      await openSessionFor(profileRef.current, id, myGen);
    },
    [openSessionFor],
  );

  const newChat = useCallback(() => {
    ++gen.current;
    closeStream();
    setRun(null);
    setMessages([]);
    setCurrentId(null);
    currentRef.current = null;
    setCurrent(null);
  }, [closeStream]);

  const openBotChat = useCallback(async () => {
    const p = pqsFor(profileRef.current);
    try {
      const res = await api.ensureBotChat(p);
      setBotChat(res.session);
      if (res.created) setNotice({ kind: "info", text: "Created the canonical Bot Chat for this profile." });
      await openSession(res.session.id);
    } catch (e) {
      setNotice(describe(e));
    }
  }, [openSession, pqsFor]);

  const send = useCallback(
    async (text: string, images: ImageAttachment[], uploads: UploadRef[]): Promise<boolean> => {
      const pName = profileRef.current;
      const p = pqsFor(pName);
      if (isActive(runRef.current)) {
        setNotice({ kind: "warning", text: "A run is already in progress. Stop it or wait for it to finish." });
        return false;
      }
      setSending(true);
      let myGen = gen.current;
      try {
        let sid = currentRef.current;
        if (!sid) {
          const created = await api.createSession(p);
          sid = created.session.id;
          myGen = ++gen.current;
          setCurrentId(sid);
          currentRef.current = sid;
          setCurrent(created.session);
          setMessages([]);
          setSessions((prev) => [created.session, ...prev.filter((s) => s.id !== created.session.id)]);
        }
        // Reuse the request id of an unconfirmed identical submission (network retry).
        const pending = readPending(pName, sid);
        const crid = pending && pending.text === text && images.length === 0 ? pending.clientRequestId : uuid();
        const record: PendingSubmission = { sessionId: sid, clientRequestId: crid, text, at: Date.now() };
        tab.set(pendingKey(pName, sid), JSON.stringify(record));
        const view = newRun(sid, text, images.map((i) => `data:${i.mime};base64,${i.data}`));
        setRun(view);
        const res = await api.createRun(p, {
          session_id: sid,
          text,
          client_request_id: crid,
          ...(images.length ? { images: images.map((i) => ({ mime: i.mime, data: i.data })) } : {}),
          ...(uploads.length ? { uploads: uploads.map((u) => u.upload_id) } : {}),
        });
        // Accepted by Hermes: an identical later message is a new turn, not a retry.
        tab.set(pendingKey(pName, sid), null);
        if (gen.current !== myGen) return true;
        const started: RunView = { ...view, runId: res.run_id, status: "running" };
        setRun(started);
        if (res.replayed) setNotice({ kind: "info", text: "Hermes already had this message — re-attached instead of sending twice." });
        attachRun(p, res.run_id, started, myGen);
        return true;
      } catch (e) {
        setRun((prev) => (prev && prev.status === "submitting" ? null : prev));
        const n = describe(e);
        setNotice(n);
        if (e instanceof DashApiError && e.status >= 400 && e.status < 500 && e.code !== "run_in_progress") {
          // Definitive rejection: the pending record must not be replayed.
          if (currentRef.current) tab.set(pendingKey(pName, currentRef.current), null);
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [attachRun, pqsFor],
  );

  const stop = useCallback(async () => {
    const view = runRef.current;
    if (!view?.runId) return;
    try {
      const res = await api.stop(pqsFor(profileRef.current), view.runId);
      setRun((prev) => (prev && prev.runId === view.runId && !TERMINAL.has(prev.status) ? { ...prev, status: res.status === "stopping" ? "stopping" : prev.status } : prev));
    } catch (e) {
      setNotice(describe(e));
    }
  }, [pqsFor]);

  const respondApproval = useCallback(
    async (cardId: string, choice: ApprovalChoice) => {
      const view = runRef.current;
      const card = view?.approvals[cardId];
      if (!view?.runId || !card || card.state !== "pending") return;
      setRun((prev) => (prev ? markApprovalSubmitting(prev, cardId) : prev));
      try {
        await api.approve(pqsFor(profileRef.current), view.runId, choice, card.requestId);
        setRun((prev) =>
          prev
            ? applyEvent(prev, { type: "approval_resolved", seq: null, choice, request_id: card.requestId })
            : prev,
        );
      } catch (e) {
        setRun((prev) => (prev ? markApprovalPending(prev, cardId) : prev));
        setNotice(describe(e));
      }
    },
    [pqsFor],
  );

  const mutateSession = useCallback(
    async (id: string, fields: { title?: string; pinned?: boolean; archived?: boolean }) => {
      try {
        const res = await api.patchSession(pqsFor(profileRef.current), id, fields);
        setSessions((prev) =>
          fields.archived ? prev.filter((s) => s.id !== id) : prev.map((s) => (s.id === id ? res.session : s)),
        );
        if (currentRef.current === id) setCurrent(res.session);
      } catch (e) {
        setNotice(describe(e));
      }
    },
    [pqsFor],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(pqsFor(profileRef.current), id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (currentRef.current === id) newChat();
      } catch (e) {
        setNotice(describe(e));
      }
    },
    [newChat, pqsFor],
  );

  const forkSession = useCallback(
    async (id: string) => {
      try {
        const res = await api.fork(pqsFor(profileRef.current), id);
        setSessions((prev) => [res.session, ...prev]);
        await openSession(res.session.id);
        setNotice({ kind: "info", text: "Forked into a new branch. The original conversation was kept." });
      } catch (e) {
        setNotice(describe(e));
      }
    },
    [openSession, pqsFor],
  );

  const loadMoreSessions = useCallback(async () => {
    await loadSessions(pqsFor(profileRef.current), gen.current, sessions.length);
  }, [loadSessions, pqsFor, sessions.length]);

  const refreshSessions = useCallback(async () => {
    await loadSessions(pqsFor(profileRef.current), gen.current);
  }, [loadSessions, pqsFor]);

  const refreshMessages = useCallback(async () => {
    const sid = currentRef.current;
    if (sid) await reloadMessages(pqsFor(profileRef.current), sid, gen.current);
  }, [pqsFor, reloadMessages]);

  const updatePrefs = useCallback(
    async (patch: Partial<Preferences>) => {
      setPrefs((prev) => ({ ...prev, ...patch }));
      try {
        const res = await api.setPreferences(pqsFor(profileRef.current), patch);
        setPrefs(res.preferences);
      } catch (e) {
        setNotice(describe(e));
      }
    },
    [pqsFor],
  );

  return {
    booting,
    bootError,
    profiles,
    launchProfile,
    profile,
    status,
    caps,
    sessions,
    sessionsHasMore,
    sessionsLoading,
    botChat,
    currentId,
    current,
    messages,
    messagesLoading,
    run,
    streamState,
    prefs,
    notice,
    online,
    sending,
    setNotice,
    switchProfile,
    openSession,
    newChat,
    openBotChat,
    send,
    stop,
    respondApproval,
    renameSession: (id, title) => mutateSession(id, { title }),
    setPinned: (id, pinned) => mutateSession(id, { pinned }),
    setArchived: (id, archived) => mutateSession(id, { archived }),
    deleteSession,
    forkSession,
    loadMoreSessions,
    refreshSessions,
    refreshMessages,
    updatePrefs,
    pqs,
  };
}
