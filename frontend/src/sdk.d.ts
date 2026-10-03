/* Ambient types for the Hermes Dashboard plugin SDK, transcribed from the installed host's
 * web/src/plugins/sdk.d.ts (SDK contract 1.1.0, Hermes v0.21.5). Members marked optional are
 * absent from older hosts / upstream docs and are feature-detected at runtime. */
import type { ComponentType } from "react";

declare global {
  const __DASH_VERSION__: string;

  interface HermesPluginSDK {
    readonly sdkVersion?: string;
    React: typeof import("react");
    hooks: Record<string, unknown>;
    api: Record<string, (...args: never[]) => unknown>;
    fetchJSON: <T = unknown>(url: string, init?: RequestInit, options?: { allowUnauthorized?: boolean }) => Promise<T>;
    authedFetch?: (url: string, init?: RequestInit) => Promise<Response>;
    buildWsUrl?: (path: string, params?: Record<string, string>) => Promise<string>;
    components: Record<string, ComponentType<never>>;
    utils: {
      cn: (...classes: Array<string | false | null | undefined>) => string;
      timeAgo: (ts: number) => string;
      isoTimeAgo: (iso: string) => string;
    };
    useI18n?: () => unknown;
  }

  interface HermesPluginRegistry {
    register(name: string, component: ComponentType<Record<string, never>>): void;
    registerSlot?(plugin: string, slot: string, component: ComponentType): void;
  }

  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSDK;
    __HERMES_PLUGINS__?: HermesPluginRegistry;
    __HERMES_BASE_PATH__?: string;
    __HERMES_AUTH_REQUIRED__?: boolean;
  }
}

export {};
