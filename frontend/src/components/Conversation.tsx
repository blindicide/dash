import { useEffect, useMemo, useRef, useState } from "react";
import type { RunView } from "../lib/runState";
import type { ApprovalChoice, Message, Session } from "../lib/types";
import { sessionTitle } from "../lib/util";
import { LiveRun } from "./LiveRun";
import { MessageItem } from "./MessageItem";
import { Btn } from "./ui";

interface Props {
  session: Session | null;
  sessionId: string | null;
  messages: Message[];
  loading: boolean;
  run: RunView | null;
  showReasoning: boolean;
  showToolDetails: boolean;
  onApproval: (cardId: string, choice: ApprovalChoice) => void;
  onBotChat: () => void;
}

export function Conversation({ session, sessionId, messages, loading, run, showReasoning, showToolDetails, onApproval, onBotChat }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);

  const toolResults = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) if (m.role === "tool" && m.tool_call_id) map.set(m.tool_call_id, m);
    return map;
  }, [messages]);
  const calledIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of messages) for (const c of m.tool_calls ?? []) if (c.id) ids.add(c.id);
    return ids;
  }, [messages]);

  // Follow the bottom unless the reader scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck) el.scrollTop = el.scrollHeight;
  }, [messages, run, stuck]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const empty = !loading && messages.length === 0 && !run;
  return (
    <div className="dash-convo">
      {session ? (
        <div className="dash-convo__title">
          <h2>{sessionTitle(session)}</h2>
          {session.is_bot_chat ? <span className="dash-badge dash-badge--secondary">Bot Chat</span> : null}
          {session.source ? <span className="dash-muted dash-small dash-hide-mobile">via {session.source}</span> : null}
        </div>
      ) : null}
      <div
        ref={scroller}
        className="dash-convo__scroll"
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="Conversation"
        tabIndex={0}
      >
        {loading && messages.length === 0 ? <p className="dash-muted dash-pad" role="status">Loading conversation…</p> : null}
        {empty ? (
          <div className="dash-empty">
            <div className="dash-empty__symbol" aria-hidden="true">\</div>
            <h2>{sessionId ? "This conversation is empty" : "Start a conversation with Hermes"}</h2>
            <p className="dash-muted">
              dash is another window onto your Hermes Agent. Everything here is stored by Hermes itself, so it also
              shows up in the CLI, the Dashboard and your messaging channels.
            </p>
            {!sessionId ? (
              <Btn variant="outlined" onClick={onBotChat}>
                Open Bot Chat
              </Btn>
            ) : null}
          </div>
        ) : null}
        {messages.map((m, i) =>
          m.role === "tool" && m.tool_call_id && calledIds.has(m.tool_call_id) ? null : (
            <MessageItem
              key={`${m.id ?? "m"}-${i}`}
              message={m}
              toolResults={toolResults}
              showReasoning={showReasoning}
              showToolDetails={showToolDetails}
            />
          ),
        )}
        {run ? <LiveRun run={run} showReasoning={showReasoning} showToolDetails={showToolDetails} onApproval={onApproval} /> : null}
      </div>
      {!stuck ? (
        <button
          type="button"
          className="dash-jump"
          onClick={() => {
            setStuck(true);
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Latest
        </button>
      ) : null}
    </div>
  );
}
