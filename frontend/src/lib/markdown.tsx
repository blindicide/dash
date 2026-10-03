/**
 * Safe Markdown → React rendering.
 *
 * `marked` is used only as a *lexer*; tokens are rendered to React elements, so raw HTML in a
 * message is shown as literal text and nothing is ever injected via innerHTML. Links are
 * limited to http(s)/mailto and open with `noopener noreferrer`. Remote images are NOT
 * auto-loaded (no tracking pixels): they render as links; inline `data:image/*` (png, jpeg,
 * gif, webp) images render directly.
 */
import { Lexer, type Token, type Tokens } from "marked";
import { useState, type ReactNode } from "react";

const SAFE_LINK = /^(https?:|mailto:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function safeHref(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const href = raw.trim();
  // Strip control chars / whitespace an attacker could use to smuggle "java\nscript:".
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  return SAFE_LINK.test(href) ? href : null;
}

export function safeImageSrc(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return SAFE_DATA_IMAGE.test(raw.trim()) ? raw.trim() : null;
}

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  };
  return (
    <div className="dash-code">
      <div className="dash-code__bar">
        <span className="dash-code__lang">{lang || "text"}</span>
        <button type="button" className="dash-linkbtn" onClick={copy} aria-label="Copy code to clipboard">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function inline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((tok, i) => renderInline(tok, `${keyPrefix}.${i}`));
}

function renderInline(tok: Token, key: string): ReactNode {
  switch (tok.type) {
    case "text": {
      const t = tok as Tokens.Text;
      return t.tokens ? <span key={key}>{inline(t.tokens, key)}</span> : <span key={key}>{t.text}</span>;
    }
    case "escape":
      return <span key={key}>{(tok as Tokens.Escape).text}</span>;
    case "strong":
      return <strong key={key}>{inline((tok as Tokens.Strong).tokens, key)}</strong>;
    case "em":
      return <em key={key}>{inline((tok as Tokens.Em).tokens, key)}</em>;
    case "del":
      return <del key={key}>{inline((tok as Tokens.Del).tokens, key)}</del>;
    case "codespan":
      return <code key={key} className="dash-inline-code">{(tok as Tokens.Codespan).text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const l = tok as Tokens.Link;
      const href = safeHref(l.href);
      const children = inline(l.tokens, key);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" title={l.title ?? undefined}>
          {children}
        </a>
      ) : (
        <span key={key}>{children}</span>
      );
    }
    case "image": {
      const im = tok as Tokens.Image;
      const src = safeImageSrc(im.href);
      if (src) return <img key={key} className="dash-md-img" src={src} alt={im.text || "image"} loading="lazy" />;
      const href = safeHref(im.href);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          [image: {im.text || href}]
        </a>
      ) : (
        <span key={key}>[image: {im.text}]</span>
      );
    }
    case "html":
      return <span key={key}>{(tok as Tokens.HTML).text}</span>;
    default:
      return <span key={key}>{"raw" in tok ? String(tok.raw) : ""}</span>;
  }
}

function renderBlock(tok: Token, key: string): ReactNode {
  switch (tok.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p key={key}>{inline((tok as Tokens.Paragraph).tokens, key)}</p>;
    case "text": {
      const t = tok as Tokens.Text;
      return <p key={key}>{t.tokens ? inline(t.tokens, key) : t.text}</p>;
    }
    case "heading": {
      const h = tok as Tokens.Heading;
      const level = Math.min(6, Math.max(1, h.depth));
      const Tag = `h${Math.min(6, level + 2)}` as "h3";
      return (
        <Tag key={key} className={`dash-md-h dash-md-h${level}`}>
          {inline(h.tokens, key)}
        </Tag>
      );
    }
    case "code": {
      const c = tok as Tokens.Code;
      return <CodeBlock key={key} text={c.text} lang={c.lang?.split(/\s/)[0]} />;
    }
    case "blockquote":
      return <blockquote key={key}>{blocks((tok as Tokens.Blockquote).tokens, key)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "list": {
      const l = tok as Tokens.List;
      const items = l.items.map((item, i) => (
        <li key={`${key}.${i}`}>
          {item.task ? (
            <input type="checkbox" checked={Boolean(item.checked)} disabled readOnly aria-label="task item" />
          ) : null}
          {blocks(item.tokens, `${key}.${i}`, true)}
        </li>
      ));
      return l.ordered ? (
        <ol key={key} start={typeof l.start === "number" ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table": {
      const t = tok as Tokens.Table;
      return (
        <div key={key} className="dash-table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table>
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th key={i} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {inline(cell.tokens, `${key}.h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={cell.align ? { textAlign: cell.align } : undefined}>
                      {inline(cell.tokens, `${key}.${r}.${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "html":
      return (
        <p key={key} className="dash-md-rawhtml">
          {(tok as Tokens.HTML).text}
        </p>
      );
    default:
      return <p key={key}>{"raw" in tok ? String(tok.raw) : ""}</p>;
  }
}

function blocks(tokens: Token[], keyPrefix: string, tight = false): ReactNode[] {
  return tokens.map((tok, i) => {
    if (tight && tok.type === "text") {
      const t = tok as Tokens.Text;
      return <span key={`${keyPrefix}.${i}`}>{t.tokens ? inline(t.tokens, `${keyPrefix}.${i}`) : t.text}</span>;
    }
    return renderBlock(tok, `${keyPrefix}.${i}`);
  });
}

const MAX_MARKDOWN_CHARS = 200_000;

export function Markdown({ text }: { text: string }) {
  const source = text.length > MAX_MARKDOWN_CHARS ? text.slice(0, MAX_MARKDOWN_CHARS) + "\n\n…(truncated)" : text;
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true, breaks: true }).lex(source);
  } catch {
    return <p className="dash-md-plain">{source}</p>;
  }
  return <div className="dash-md">{blocks(tokens, "md")}</div>;
}
