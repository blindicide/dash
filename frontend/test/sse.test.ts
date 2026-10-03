import { SSEParser } from "../src/lib/sse";

test("parses frames split across chunks, CRLF and comments", () => {
  const p = new SSEParser();
  const frames = [
    ...p.feed("id: 3\r"),
    ...p.feed("\ndata: {\"a\":"),
    ...p.feed("1}\r\n\r\n: keepalive\n\nid: 4\ndata: x\ndata: y\n\n"),
  ];
  expect(frames).toEqual([
    { id: "3", data: '{"a":1}', comment: null },
    { id: null, data: null, comment: "keepalive" },
    { id: "4", data: "x\ny", comment: null },
  ]);
});
