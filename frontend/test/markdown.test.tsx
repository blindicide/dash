import { render } from "@testing-library/react";
import { Markdown, safeHref, safeImageSrc } from "../src/lib/markdown";

test("raw HTML is rendered as text, never as elements", () => {
  const { container } = render(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> hi'} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
});

test("dangerous links are not clickable; safe links are hardened", () => {
  const { container } = render(<Markdown text={"[x](javascript:alert(1)) [y](https://example.com) [z](java\nscript:alert(1))"} />);
  const anchors = Array.from(container.querySelectorAll("a"));
  expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://example.com"]);
  expect(anchors[0]!.getAttribute("rel")).toContain("noopener");
  expect(anchors[0]!.getAttribute("target")).toBe("_blank");
});

test("images: only raster data URIs inline, remote images become links", () => {
  expect(safeImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  expect(safeImageSrc("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  expect(safeImageSrc("https://tracker.example/p.gif")).toBeNull();
  expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  expect(safeHref("data:text/html,x")).toBeNull();
  const { container } = render(<Markdown text={"![pix](https://tracker.example/p.gif)"} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")?.textContent).toContain("image");
});

test("code blocks and tables render", () => {
  const { container, getByRole } = render(<Markdown text={"```py\nprint('<b>')\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />);
  expect(container.querySelector("pre code")?.textContent).toBe("print('<b>')");
  expect(getByRole("table")).toBeInTheDocument();
  expect(container.querySelector("b")).toBeNull();
});
