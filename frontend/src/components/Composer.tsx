import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, DashApiError } from "../lib/api";
import { draftKey, tab } from "../lib/storage";
import type { Capabilities, ImageAttachment, ModelChoice, ModelChoices, UploadRef } from "../lib/types";
import { fileToBase64, formatBytes, uuid } from "../lib/util";
import { Btn } from "./ui";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface Props {
  profileName: string;
  profileQs: string | null;
  sessionId: string | null;
  caps: Capabilities | null;
  busy: boolean;
  sending: boolean;
  canStop: boolean;
  online: boolean;
  enterToSend: boolean;
  onSend: (text: string, images: ImageAttachment[], uploads: UploadRef[], model?: ModelChoice | null) => Promise<boolean>;
  models: ModelChoices | null;
  model: ModelChoice | null;
  onModel: (choice: ModelChoice | null) => void;
  onStop: () => void;
  onError: (text: string) => void;
}

export function Composer(props: Props) {
  const { profileName, sessionId, caps, busy, sending, canStop, online, enterToSend } = props;
  const key = draftKey(profileName, sessionId);
  const [text, setText] = useState(() => tab.get(key) ?? "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [uploads, setUploads] = useState<UploadRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);

  const imagesSupported = Boolean(caps?.media.images) && caps?.runs.submit;
  const maxBytes = caps?.media.image_max_bytes ?? 5 * 1024 * 1024;
  const maxCount = caps?.media.image_max_count ?? 4;
  // Hermes caps the whole run request body, so images of one message share a budget.
  const maxTotal = caps?.media.image_total_max_bytes ?? 7_000_000;

  // Restore the draft that belongs to this profile/session (drafts survive reloads in-tab).
  const textRef = useRef(text);
  const sendingRef = useRef(sending);
  useLayoutEffect(() => {
    textRef.current = text;
    sendingRef.current = sending;
  });
  const prev = useRef({ sessionId, profileName });
  useEffect(() => {
    const createdFromNew =
      prev.current.sessionId === null && sessionId !== null && prev.current.profileName === profileName && sendingRef.current;
    prev.current = { sessionId, profileName };
    // A brand-new chat gets its session id mid-send: keep the composer content so a failed
    // first send does not lose the text or attachments.
    if (createdFromNew) {
      tab.set(key, textRef.current || null);
      tab.set(draftKey(profileName, null), null);
      return;
    }
    setText(tab.get(key) ?? "");
    setImages([]);
    setUploads([]);
  }, [key, sessionId, profileName]);

  const updateText = (value: string) => {
    setText(value);
    tab.set(key, value ? value : null);
  };

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => () => imagesRef.current.forEach((i) => URL.revokeObjectURL(i.previewUrl)), []);

  const addImages = async (files: File[]) => {
    if (!imagesSupported) {
      props.onError("This Hermes does not accept image input through dash.");
      return;
    }
    const accepted: ImageAttachment[] = [];
    for (const f of files) {
      if (!IMAGE_TYPES.includes(f.type)) {
        props.onError(`${f.name || "file"}: only PNG, JPEG, GIF and WebP images are supported.`);
        continue;
      }
      if (f.size > maxBytes) {
        props.onError(`${f.name || "image"} is ${formatBytes(f.size)}; the limit is ${formatBytes(maxBytes)}.`);
        continue;
      }
      if (images.length + accepted.length >= maxCount) {
        props.onError(`At most ${maxCount} images per message.`);
        break;
      }
      const total = [...images, ...accepted].reduce((sum, i) => sum + i.size, 0) + f.size;
      if (total > maxTotal) {
        props.onError(`${f.name || "image"} would bring this message's images over ${formatBytes(maxTotal)}.`);
        continue;
      }
      accepted.push({
        id: uuid(),
        name: f.name || "pasted-image",
        mime: f.type,
        size: f.size,
        data: await fileToBase64(f),
        previewUrl: URL.createObjectURL(f),
      });
    }
    if (accepted.length) setImages((prev) => [...prev, ...accepted]);
  };

  const addDocuments = async (files: File[]) => {
    for (const f of files) {
      try {
        const ref = await api.upload(props.profileQs, f);
        setUploads((prev) => [...prev, ref]);
      } catch (e) {
        props.onError(e instanceof DashApiError ? `${f.name}: ${e.message}` : `${f.name}: upload failed.`);
      }
    }
  };

  const submit = async () => {
    const body = text.trim();
    if ((!body && images.length === 0 && uploads.length === 0) || busy || sending) return;
    const ok = await props.onSend(body, images, uploads, props.model);
    if (ok) {
      setText("");
      tab.set(key, null);
      images.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setImages([]);
      setUploads([]);
    }
  };

  return (
    <form
      className={`dash-composer${dragging ? " is-dragging" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => {
        if ((imagesSupported || caps?.media.uploads) && Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (!files.length) return;
        e.preventDefault();
        void addImages(files.filter((f) => f.type.startsWith("image/")));
        const docs = files.filter((f) => !f.type.startsWith("image/"));
        if (docs.length) {
          if (caps?.media.uploads) void addDocuments(docs);
          else props.onError("File uploads are disabled on this server; only images can be attached.");
        }
      }}
      aria-label="Message composer"
    >
      {images.length || uploads.length ? (
        <ul className="dash-attachments" aria-label="Attachments">
          {images.map((img) => (
            <li key={img.id} className="dash-attachment">
              <img src={img.previewUrl} alt={`Preview of ${img.name}`} />
              <span className="dash-small">{formatBytes(img.size)}</span>
              <button
                type="button"
                className="dash-attachment__remove"
                aria-label={`Remove ${img.name}`}
                onClick={() => {
                  URL.revokeObjectURL(img.previewUrl);
                  setImages((prev) => prev.filter((x) => x.id !== img.id));
                }}
              >
                ×
              </button>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.upload_id} className="dash-attachment dash-attachment--doc">
              <span className="dash-small">📄 {u.name}</span>
              <span className="dash-small dash-muted">{formatBytes(u.size)}</span>
              <button
                type="button"
                className="dash-attachment__remove"
                aria-label={`Remove ${u.name}`}
                onClick={() => {
                  setUploads((prev) => prev.filter((x) => x.upload_id !== u.upload_id));
                  void api.deleteUpload(props.profileQs, u.upload_id).catch((e) =>
                    props.onError(e instanceof DashApiError ? `${u.name}: ${e.message}` : `${u.name}: could not remove upload.`),
                  );
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dash-composer__row">
        {imagesSupported ? (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                void addImages(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Btn variant="ghost" size="icon" aria-label="Attach image" title="Attach image" onClick={() => fileInput.current?.click()}>
              <span aria-hidden="true">🖼</span>
            </Btn>
          </>
        ) : null}
        {caps?.media.uploads ? (
          <>
            <input
              ref={docInput}
              type="file"
              hidden
              accept=".txt,.md,.csv,.json,.log,.pdf"
              onChange={(e) => {
                void addDocuments(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Btn variant="ghost" size="icon" aria-label="Attach file" title="Attach file" onClick={() => docInput.current?.click()}>
              <span aria-hidden="true">📎</span>
            </Btn>
          </>
        ) : null}
        <label className="dash-composer__field">
          <span className="dash-sr">Message Hermes</span>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={online ? "Message Hermes…" : "Offline — your text is kept until you can send"}
            onChange={(e) => updateText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (files.length && imagesSupported) {
                e.preventDefault();
                void addImages(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (enterToSend || e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-describedby="dash-composer-hint"
          />
        </label>
        {canStop ? (
          <Btn variant="destructive" onClick={props.onStop} aria-label="Stop the running agent">
            Stop
          </Btn>
        ) : (
          <Btn
            type="submit"
            disabled={busy || sending || !online || (!text.trim() && images.length === 0 && uploads.length === 0)}
            aria-label="Send message"
          >
            {sending ? "Sending…" : "Send"}
          </Btn>
        )}
      </div>
      {props.models?.available && props.models.providers.length ? (
        <div className="dash-composer__meta">
          <label className="dash-select dash-small">
            <span className="dash-muted">Model </span>
            <select
              aria-label="Model for the next message"
              value={props.model ? `${props.model.provider}\u0000${props.model.model}` : ""}
              onChange={(e) => {
                const [provider, model] = e.target.value.split("\u0000");
                props.onModel(provider && model ? { provider, model } : null);
              }}
            >
              <option value="">
                Hermes default{props.models.current?.model ? ` (${props.models.current.model})` : ""}
              </option>
              {props.models.providers.map((p) => (
                <optgroup key={p.provider} label={p.name}>
                  {p.models.map((m) => (
                    <option key={`${p.provider}/${m}`} value={`${p.provider}\u0000${m}`}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <p id="dash-composer-hint" className="dash-sr">
        {enterToSend ? "Enter sends, Shift+Enter adds a new line." : "Ctrl or Cmd + Enter sends."}
      </p>
    </form>
  );
}
