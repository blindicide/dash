#!/usr/bin/env node
// page.evaluate() callbacks run in the browser:
/* global window, document, KeyboardEvent */
// Real-browser end-to-end checks for dash against the isolated Hermes environment
// (scripts/integration/env.sh up). Drives headless Chromium through the actual Hermes
// Dashboard page at /dash: plugin load, send + stream, reload during an active run, approval
// via the UI, keyboard shortcut, mobile drawer. Writes .integration/browser-report.json and
// screenshots under .integration/screens/.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = process.env.DASH_IT_DIR ?? join(root, ".integration");
const base = `http://127.0.0.1:${process.env.DASH_IT_DASHBOARD_PORT ?? "19119"}`;
const tag = Math.random().toString(16).slice(2, 8);
const shots = join(work, "screens");
mkdirSync(shots, { recursive: true });

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, seconds: (Date.now() - t0) / 1000, detail: detail ?? null });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ check: name, ok: false, seconds: (Date.now() - t0) / 1000, error: String(e?.stack ?? e).slice(0, 800) });
    console.log(`FAIL  ${name}: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

const browser = await chromium.launch({ headless: true });
const consoleErrors = [];

async function openDash(context) {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(`${base}/dash`, { waitUntil: "domcontentloaded" });
  await page.locator(".dash-brand").waitFor({ timeout: 30000 });
  return page;
}

async function send(page, text) {
  const box = page.getByLabel("Message Hermes");
  await box.fill(text);
  await box.press("Enter");
}

const desktop = await browser.newContext({ viewport: { width: 1360, height: 860 } });
let page;

await check("plugin page renders inside the Hermes Dashboard with brand + version", async () => {
  page = await openDash(desktop);
  const brand = await page.locator(".dash-brand").innerText();
  if (!brand.includes("\\") || !/dash/.test(brand) || !/v\d+\.\d+\.\d+/.test(brand)) throw new Error(`brand: ${brand}`);
  const nav = await page.getByRole("link", { name: /dash/ }).count();
  await page.locator(".dash-conn", { hasText: "Connected" }).waitFor({ timeout: 30000 });
  const conn = await page.locator(".dash-conn").innerText();
  if (!/Connected/.test(conn)) throw new Error(`connection: ${conn}`);
  await page.screenshot({ path: join(shots, "desktop-initial.png") });
  return { brand: brand.replace(/\s+/g, " "), nav_links: nav, connection: conn };
});

await check("send from the browser and see the streamed Hermes answer", async () => {
  await page.getByRole("button", { name: /New chat/ }).click();
  await send(page, `hello from the browser ${tag}`);
  await page.getByText(`dash-e2e-ok: hello from the browser ${tag}`).first().waitFor({ timeout: 60000 });
  await page.screenshot({ path: join(shots, "desktop-answer.png") });
  return { answered: true };
});

await check("reload during an active run re-attaches without resending", async () => {
  await send(page, `E2E-SLOW browser reload ${tag}`);
  await page.getByText(/tick3\b/).first().waitFor({ timeout: 60000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".dash-brand").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Stop the running agent" }).waitFor({ timeout: 30000 });
  await page.getByText(/tick39/).first().waitFor({ timeout: 90000 });
  await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 60000 });
  const userBubbles = await page.locator(".dash-msg--user", { hasText: `E2E-SLOW browser reload ${tag}` }).count();
  if (userBubbles !== 1) throw new Error(`expected exactly one user turn, saw ${userBubbles}`);
  return { user_turns: userBubbles };
});

await check("approval card requires an explicit click; Deny resolves through Hermes", async () => {
  await send(page, `E2E-DANGER deny via browser ${tag}`);
  const card = page.getByRole("alertdialog", { name: "Approval required" });
  await card.waitFor({ timeout: 60000 });
  const text = await card.innerText();
  if (!/rm -rf/.test(text)) throw new Error(`approval text: ${text}`);
  await page.screenshot({ path: join(shots, "desktop-approval.png") });
  await card.getByRole("button", { name: "Deny" }).click();
  await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 60000 });
  return { approval_text: text.slice(0, 200) };
});

await check("Ctrl+K opens history search; plain Ctrl+N is not intercepted", async () => {
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  if (prevented) throw new Error("Ctrl+N was intercepted");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await search.waitFor({ timeout: 10000 });
  await search.fill(tag);
  await page.getByRole("option").first().waitFor({ timeout: 20000 });
  await page.keyboard.press("Escape");
  return { ctrl_n_prevented: prevented };
});

await check("mobile viewport: drawer, sticky composer, no horizontal overflow", async () => {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await openDash(mobile);
  const menu = m.getByRole("button", { name: "Open conversation list" });
  await menu.waitFor({ timeout: 15000 });
  const composerBox = await m.locator(".dash-composer").boundingBox();
  if (!composerBox || composerBox.y + composerBox.height > 844 + 1) throw new Error(`composer off-screen: ${JSON.stringify(composerBox)}`);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // Documentation screenshots without the scratch home's first-run host banner.
  const noThanks = m.getByRole("button", { name: "No thanks" });
  if (await noThanks.count()) {
    await noThanks.first().click();
    await m.waitForTimeout(500);
  }
  const after = await m.locator(".dash-composer").boundingBox();
  if (!after || after.y + after.height > 844 + 1) throw new Error(`composer off-screen after banner dismissal: ${JSON.stringify(after)}`);
  await m.screenshot({ path: join(shots, "mobile-conversation.png") });
  await menu.click();
  await m.locator(".dash-sidebar.is-open").waitFor({ timeout: 5000 });
  await m.waitForTimeout(400); // drawer slide-in transition
  const drawer = await m.locator(".dash-sidebar").boundingBox();
  if (!drawer || drawer.x < -1) throw new Error(`drawer not fully open: ${JSON.stringify(drawer)}`);
  await m.screenshot({ path: join(shots, "mobile-drawer.png") });
  await mobile.close();
  return { composer_bottom: composerBox.y + composerBox.height, horizontal_overflow_px: overflow };
});

await check("no dash console errors", async () => {
  const relevant = consoleErrors.filter((e) => /dash|plugins\/dash/i.test(e));
  if (relevant.length) throw new Error(relevant.join(" | "));
  return { all_console_errors: consoleErrors.slice(0, 10) };
});

await browser.close();
const report = {
  generated_at: new Date().toISOString(),
  browser: `chromium (playwright-core ${JSON.parse(readFileSync(join(root, "node_modules/playwright-core/package.json"), "utf8")).version})`,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(work, "browser-report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed -> ${join(work, "browser-report.json")}`);
process.exit(report.failed ? 1 : 0);
