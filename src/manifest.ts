import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  ACTION_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ClawNet",
  description:
    "Agent marketplace bridge: browse, search, and hire agents from the ClawNet registry with trust-gated attestations",
  author: "bOpen",
  categories: ["connector"],
  capabilities: [
    "agents.read",
    "agents.invoke",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "ui.sidebar.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      clawnetApiUrl: {
        type: "string",
        title: "ClawNet API URL",
        default: DEFAULT_CONFIG.clawnetApiUrl,
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync Interval (minutes)",
        default: DEFAULT_CONFIG.syncIntervalMinutes,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.sync,
      displayName: "ClawNet Registry Sync",
      description:
        "Pulls agents and skills from the ClawNet registry into plugin state.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.agentLookup,
      displayName: "ClawNet Agent Lookup",
      description:
        "Look up a ClawNet agent by slug and return its profile, trust score, skills, and attestations.",
      parametersSchema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The ClawNet agent slug to look up.",
          },
        },
        required: ["slug"],
      },
    },
    {
      name: TOOL_NAMES.skillSearch,
      displayName: "ClawNet Skill Search",
      description:
        "Search available skills from the ClawNet registry by keyword or category.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for skill name, description, or tags.",
          },
          category: {
            type: "string",
            description: "Optional category filter.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.fleetOverview,
      displayName: "ClawNet Fleet Overview",
      description:
        "Return a summary of all ClawNet agents including count, status breakdown, and top skills.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.hireClawnetAgent,
      displayName: "Hire ClawNet Agent",
      description:
        "Hire an agent from the ClawNet registry into this Paperclip company. Looks up the agent by slug and invokes the hiring flow.",
      parametersSchema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "ClawNet agent slug to hire.",
          },
        },
        required: ["slug"],
      },
    },
    {
      name: TOOL_NAMES.linkAgent,
      displayName: "Link Agent to ClawNet Template",
      description:
        "Link an existing Paperclip agent to a ClawNet registry template by agent ID and ClawNet slug.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description: "Paperclip agent UUID to link.",
          },
          clawnetSlug: {
            type: "string",
            description: "ClawNet agent slug to link to.",
          },
        },
        required: ["agentId", "clawnetSlug"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "ClawNet Fleet",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "ClawNet Marketplace",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "ClawNet",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "ClawNet Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
