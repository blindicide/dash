#!/usr/bin/env node
// Keep the dash version identical everywhere it is visible:
//   package.json, package-lock.json, pyproject.toml, plugin manifest, BFF version.py, CHANGELOG.
// Usage: node scripts/version.mjs check | set <X.Y.Z> | get
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (rel) => join(root, rel);
const SEMVER = /^\d+\.\d+\.\d+$/;

const sources = {
  "package.json": () => JSON.parse(readFileSync(p("package.json"), "utf8")).version,
  "package-lock.json": () => JSON.parse(readFileSync(p("package-lock.json"), "utf8")).version,
  "pyproject.toml": () => /^version = "([^"]+)"/m.exec(readFileSync(p("pyproject.toml"), "utf8"))?.[1],
  "plugin/dashboard/manifest.json": () =>
    JSON.parse(readFileSync(p("plugin/dashboard/manifest.json"), "utf8")).version,
  "plugin/dashboard/dash_bff/version.py": () =>
    /__version__ = "([^"]+)"/.exec(readFileSync(p("plugin/dashboard/dash_bff/version.py"), "utf8"))?.[1],
  "CHANGELOG.md (latest entry)": () => /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(p("CHANGELOG.md"), "utf8"))?.[1],
};

function collect() {
  return Object.fromEntries(
    Object.entries(sources).map(([name, read]) => {
      try {
        return [name, read() ?? null];
      } catch {
        return [name, null];
      }
    }),
  );
}

function setVersion(v) {
  const json = (rel, mutate) => {
    const data = JSON.parse(readFileSync(p(rel), "utf8"));
    mutate(data);
    writeFileSync(p(rel), JSON.stringify(data, null, 2) + "\n");
  };
  json("package.json", (d) => (d.version = v));
  json("package-lock.json", (d) => {
    d.version = v;
    if (d.packages?.[""]) d.packages[""].version = v;
  });
  json("plugin/dashboard/manifest.json", (d) => (d.version = v));
  const text = (rel, re, repl) => writeFileSync(p(rel), readFileSync(p(rel), "utf8").replace(re, repl));
  text("pyproject.toml", /^version = "[^"]+"/m, `version = "${v}"`);
  text("plugin/dashboard/dash_bff/version.py", /__version__ = "[^"]+"/, `__version__ = "${v}"`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "get") {
  console.log(sources["package.json"]());
} else if (cmd === "set") {
  if (!SEMVER.test(arg ?? "")) {
    console.error("usage: version.mjs set X.Y.Z");
    process.exit(2);
  }
  setVersion(arg);
  console.log(`version set to ${arg} (add a CHANGELOG entry: ## [${arg}])`);
} else if (cmd === "check" || !cmd) {
  const found = collect();
  const values = new Set(Object.values(found));
  for (const [name, v] of Object.entries(found)) console.log(`${String(v).padEnd(10)} ${name}`);
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null;
  if (values.size !== 1 || values.has(null) || !SEMVER.test([...values][0])) {
    console.error("version mismatch");
    process.exit(1);
  }
  if (tag && tag !== `v${[...values][0]}`) {
    console.error(`tag ${tag} does not match version v${[...values][0]}`);
    process.exit(1);
  }
  console.log(`ok: ${[...values][0]}`);
} else {
  console.error("usage: version.mjs check|get|set X.Y.Z");
  process.exit(2);
}
