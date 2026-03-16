import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "bopen-io.clawnet-plugin",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "ClawNet",
  description: "Agent marketplace bridge: browse, search, and hire agents from the ClawNet registry with trust-gated attestations",
  author: "bOpen",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "ClawNet Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
