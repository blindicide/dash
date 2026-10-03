/** Incremental SSE parser (fetch streams; EventSource cannot send the Dashboard auth header). */

export interface SSEFrame {
  id: string | null;
  data: string | null;
  comment: string | null;
}

export class SSEParser {
  private buf = "";
  private id: string | null = null;
  private data: string[] = [];

  feed(chunk: string): SSEFrame[] {
    this.buf += chunk;
    const out: SSEFrame[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      // A trailing lone \r may be the first half of \r\n: wait for more input.
      if (this.buf[nl] === "\r" && nl === this.buf.length - 1) break;
      const sepLen = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + sepLen);
      if (line === "") {
        if (this.data.length || this.id !== null) {
          out.push({ id: this.id, data: this.data.join("\n"), comment: null });
        }
        this.id = null;
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) {
        out.push({ id: null, data: null, comment: line.slice(1).trim() });
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
    }
    return out;
  }
}
