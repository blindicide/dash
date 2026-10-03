import "@testing-library/jest-dom/vitest";
import * as React from "react";

// The real host provides window.__HERMES_PLUGIN_SDK__; tests install a minimal one backed by
// the real React (React is aliased to the host singleton only in the production build).
(globalThis as unknown as { __DASH_VERSION__: string }).__DASH_VERSION__ = "test";
window.__HERMES_PLUGIN_SDK__ = {
  sdkVersion: "1.1.0",
  React: React as unknown as typeof import("react"),
  hooks: {},
  api: {},
  fetchJSON: async () => {
    throw new Error("fetchJSON not mocked");
  },
  authedFetch: async () => {
    throw new Error("authedFetch not mocked");
  },
  components: {},
  utils: { cn: (...c) => c.filter(Boolean).join(" "), timeAgo: () => "", isoTimeAgo: () => "" },
};
