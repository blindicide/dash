/**
 * dash (\) — Hermes Dashboard plugin entry. Loaded by the Dashboard as a classic <script>
 * (IIFE). Registers the page component under the manifest name "dash".
 */
import "./styles/dash.css";
import { DashApp } from "./components/DashApp";

const NAME = "dash";

function register(): void {
  const registry = window.__HERMES_PLUGINS__;
  const sdk = window.__HERMES_PLUGIN_SDK__;
  if (!registry || !sdk?.React) {
    console.warn("[dash] Hermes plugin SDK not found; dash requires the Hermes Dashboard plugin host.");
    return;
  }
  registry.register(NAME, DashApp as unknown as Parameters<HermesPluginRegistry["register"]>[1]);
}

register();
