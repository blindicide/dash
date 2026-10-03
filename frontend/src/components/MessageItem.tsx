import { Markdown, safeImageSrc } from "../lib/markdown";
import type { ContentPart, Message } from "../lib/types";
import { toMs } from "../lib/util";
import { ToolCard } from "./ToolCard";

interface Props {
  message: Message;
  toolResults: Map<string, Message>;
  showReasoning: boolean;
  showToolDetails: boolean;
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function images(content: string | ContentPart[]): (string | null)[] {
  return typeof content === "string" ? [] : content.filter((p) => p.type === "image").map((p) => (p as { url: string | null }).url);
}

export function Timestamp({ ts }: { ts: number | null | undefined }) {
  const ms = toMs(ts);
  if (ms === null) return null;
  const d = new Date(ms);
  return (
    <time className="dash-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

export function MessageItem({ message, toolResults, showReasoning, showToolDetails }: Props) {
  const text = textOf(message.content);
  const imgs = images(message.content);
  if (message.role === "user") {
    return (
      <article className="dash-msg dash-msg--user" aria-label="You">
        <div className="dash-bubble">
          {imgs.length ? (
            <div className="dash-msg__images">
              {imgs.map((url, i) => {
                const src = safeImageSrc(url);
                return src ? <img key={i} src={src} alt={`Attached image ${i + 1}`} /> : <span key={i} className="dash-muted">[image]</span>;
              })}
            </div>
          ) : null}
          {text ? <Markdown text={text} /> : null}
        </div>
        <Timestamp ts={message.timestamp} />
      </article>
    );
  }
  if (message.role === "tool") {
    return (
      <div className="dash-msg dash-msg--tool">
        <ToolCard tool={message.tool_name || "tool"} status="completed" result={text} showDetails={showToolDetails} />
      </div>
    );
  }
  if (message.role === "system") {
    return text ? (
      <div className="dash-msg dash-msg--system dash-muted dash-small" role="note">
        {text.slice(0, 500)}
      </div>
    ) : null;
  }
  return (
    <article className="dash-msg dash-msg--assistant" aria-label="Hermes">
      {showReasoning && message.reasoning ? (
        <details className="dash-reasoning">
          <summary>Reasoning exposed by the model</summary>
          <Markdown text={message.reasoning} />
        </details>
      ) : null}
      {message.tool_calls?.map((call, i) => {
        const result = call.id ? toolResults.get(call.id) : undefined;
        const resultText = result ? textOf(result.content) : undefined;
        return (
          <ToolCard
            key={call.id ?? i}
            tool={call.name}
            status={result ? (/^(error|failed)/i.test(resultText ?? "") ? "failed" : "completed") : "completed"}
            args={call.arguments}
            result={resultText}
            showDetails={showToolDetails}
          />
        );
      })}
      {text ? (
        <div className="dash-assistant">
          <Markdown text={text} />
        </div>
      ) : null}
      {text ? <Timestamp ts={message.timestamp} /> : null}
    </article>
  );
}
