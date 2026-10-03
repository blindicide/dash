/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const shim = (p: string) => fileURLToPath(new URL(`./frontend/src/sdk-shims/${p}`, import.meta.url));

// The Hermes Dashboard loads plugins as a single classic <script> (IIFE) and provides React via
// window.__HERMES_PLUGIN_SDK__.React. React is therefore never bundled: `react` and the JSX
// runtime are aliased to tiny shims that forward to the host's React singleton.
export default defineConfig(({ mode }) => ({
  define: {
    __DASH_VERSION__: JSON.stringify(pkg.version),
    "process.env.NODE_ENV": JSON.stringify(mode === "test" ? "test" : "production"),
  },
  resolve:
    mode === "test"
      ? {}
      : {
          alias: [
            { find: /^react\/jsx-runtime$/, replacement: shim("jsx-runtime.ts") },
            { find: /^react\/jsx-dev-runtime$/, replacement: shim("jsx-runtime.ts") },
            { find: /^react$/, replacement: shim("react.ts") },
          ],
        },
  build: {
    outDir: "plugin/dashboard/dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: "frontend/src/main.tsx",
      name: "HermesDashPlugin",
      formats: ["iife"],
      fileName: () => "index.js",
      cssFileName: "style",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["frontend/test/setup.ts"],
    include: ["frontend/test/**/*.test.{ts,tsx}"],
  },
}));
