// ---------------------------------------------------------------------------
// Stable identifiers for the ClawNet plugin.
//
// All IDs, keys, export names, and route segments live here so they can be
// referenced from both the manifest and the worker/UI without risk of drift.
// ---------------------------------------------------------------------------

export const PLUGIN_ID = "bopen-io.clawnet-plugin";
declare const __PLUGIN_VERSION__: string;
export const PLUGIN_VERSION = __PLUGIN_VERSION__;
export const PAGE_ROUTE = "clawnet";

// ---------------------------------------------------------------------------
// UI slot IDs (must be unique within this plugin)
// ---------------------------------------------------------------------------

export const SLOT_IDS = {
  dashboardWidget: "clawnet-dashboard-widget",
  page: "clawnet-page",
  sidebar: "clawnet-sidebar-link",
  settingsPage: "clawnet-settings-page",
} as const;

// ---------------------------------------------------------------------------
// React component export names (must match the named exports in the UI bundle)
// ---------------------------------------------------------------------------

export const EXPORT_NAMES = {
  dashboardWidget: "ClawNetFleetWidget",
  page: "ClawNetMarketplacePage",
  sidebar: "ClawNetSidebarLink",
  settingsPage: "ClawNetSettingsPage",
} as const;

// ---------------------------------------------------------------------------
// Scheduled job keys
// ---------------------------------------------------------------------------

export const JOB_KEYS = {
  sync: "clawnet-sync",
} as const;

// ---------------------------------------------------------------------------
// Agent tool names (kebab-case, namespaced at runtime by the host)
// ---------------------------------------------------------------------------

export const TOOL_NAMES = {
  agentLookup: "agent-lookup",
  skillSearch: "skill-search",
  fleetOverview: "fleet-overview",
} as const;

// ---------------------------------------------------------------------------
// Stream channel names
// ---------------------------------------------------------------------------

export const STREAM_CHANNELS = {
  fleetStatus: "clawnet:fleet-status",
  syncProgress: "clawnet:sync-progress",
} as const;

// ---------------------------------------------------------------------------
// Entity types (for ctx.entities)
// ---------------------------------------------------------------------------

export const ENTITY_TYPES = {
  agent: "clawnet-agent",
  skill: "clawnet-skill",
} as const;

// ---------------------------------------------------------------------------
// Data handler keys (for ctx.data.register / usePluginData)
// ---------------------------------------------------------------------------

export const DATA_KEYS = {
  clawnetAgents: "clawnet-agents",
  clawnetSkills: "clawnet-skills",
  syncStatus: "sync-status",
  fleetSummary: "fleet-summary",
} as const;

// ---------------------------------------------------------------------------
// Action handler keys (for ctx.actions.register / usePluginAction)
// ---------------------------------------------------------------------------

export const ACTION_KEYS = {
  triggerSync: "trigger-sync",
  linkAgent: "link-agent",
  validateConfig: "validate-config",
} as const;

// ---------------------------------------------------------------------------
// Event types we subscribe to
// ---------------------------------------------------------------------------

export const EVENT_TYPES = {
  agentStatusChanged: "agent.status_changed",
  agentCreated: "agent.created",
} as const;

// ---------------------------------------------------------------------------
// State keys (for ctx.state)
// ---------------------------------------------------------------------------

export const STATE_KEYS = {
  syncCursor: "clawnet-sync-cursor",
  clawnetLink: "clawnet-link",
} as const;

// ---------------------------------------------------------------------------
// Default instance configuration values
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  clawnetApiUrl: "https://clawnet.sh",
  clawnetApiKey: "",
  syncIntervalMinutes: 15,
} as const;
