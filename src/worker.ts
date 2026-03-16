import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { PluginHealthDiagnostics, PluginConfigValidationResult } from "@paperclipai/plugin-sdk";
import { createClawNetClient } from "./clawnet-api.js";
import {
  DEFAULT_CONFIG,
  JOB_KEYS,
  TOOL_NAMES,
  STREAM_CHANNELS,
  DATA_KEYS,
  ACTION_KEYS,
  EVENT_TYPES,
  ENTITY_TYPES,
  STATE_KEYS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClawNetConfig = {
  clawnetApiUrl?: string;
  clawnetApiKey?: string;
};

type SyncCursor = {
  lastSyncAt: string;
  agentCount: number;
  skillCount: number;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let currentContext: PluginContext | null = null;
const openStreams = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function getConfig(ctx: PluginContext): Promise<ClawNetConfig> {
  const raw = await ctx.config.get();
  return raw as ClawNetConfig;
}

async function resolveApiKey(ctx: PluginContext, config: ClawNetConfig): Promise<string> {
  if (!config.clawnetApiKey) {
    throw new Error("ClawNet API key is not configured");
  }
  return await ctx.secrets.resolve(config.clawnetApiKey);
}

async function getSyncCursor(ctx: PluginContext): Promise<SyncCursor | null> {
  const cursor = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.syncCursor,
  });
  return cursor as SyncCursor | null;
}

async function setSyncCursor(ctx: PluginContext, cursor: SyncCursor): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: STATE_KEYS.syncCursor },
    cursor,
  );
}

function getListParams(params: Record<string, unknown>) {
  const search = typeof params.search === "string" ? params.search : undefined;
  const page = typeof params.page === "number" ? params.page : 1;
  const limit = typeof params.limit === "number" ? Math.min(params.limit, 100) : 25;
  const companyId = typeof params.companyId === "string" ? params.companyId : "";
  if (!companyId) {
    throw new Error("companyId is required");
  }
  return { companyId, search, page, limit };
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function performSync(ctx: PluginContext, streamProgress: boolean): Promise<SyncCursor> {
  const config = await getConfig(ctx);
  const apiKey = await resolveApiKey(ctx, config);
  const client = createClawNetClient({
    baseUrl: config.clawnetApiUrl || DEFAULT_CONFIG.clawnetApiUrl,
    apiKey,
    fetchFn: ctx.http.fetch.bind(ctx.http),
  });

  const startedAt = Date.now();

  if (streamProgress) {
    ctx.streams.open(STREAM_CHANNELS.syncProgress, "");
    openStreams.add(STREAM_CHANNELS.syncProgress);
  }

  // --- Sync agents ---
  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "agents",
      status: "fetching",
      message: "Fetching agents from ClawNet registry...",
    });
  }

  let agentCount = 0;
  let agentCursor: string | undefined;
  do {
    const agentResponse = await client.listAgents({ cursor: agentCursor });
    for (const agent of agentResponse.agents) {
      await ctx.entities.upsert({
        entityType: ENTITY_TYPES.agent,
        scopeKind: "instance",
        externalId: agent.slug || agent._id,
        title: agent.displayName || agent.name,
        status: agent.deleted ? "deleted" : "active",
        data: agent as unknown as Record<string, unknown>,
      });
      agentCount++;
    }
    agentCursor = agentResponse.hasMore ? agentResponse.cursor : undefined;
  } while (agentCursor);

  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "agents",
      status: "complete",
      message: `Synced ${agentCount} agents`,
      count: agentCount,
    });
  }

  // --- Sync skills ---
  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "skills",
      status: "fetching",
      message: "Fetching skills from ClawNet registry...",
    });
  }

  let skillCount = 0;
  let skillCursor: string | undefined;
  do {
    const skillResponse = await client.listSkills({ cursor: skillCursor });
    for (const skill of skillResponse.skills) {
      await ctx.entities.upsert({
        entityType: ENTITY_TYPES.skill,
        scopeKind: "instance",
        externalId: skill.slug || skill._id,
        title: skill.name,
        status: "available",
        data: skill as unknown as Record<string, unknown>,
      });
      skillCount++;
    }
    skillCursor = skillResponse.hasMore ? skillResponse.cursor : undefined;
  } while (skillCursor);

  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "skills",
      status: "complete",
      message: `Synced ${skillCount} skills`,
      count: skillCount,
    });
  }

  // --- Persist cursor ---
  const cursor: SyncCursor = {
    lastSyncAt: new Date().toISOString(),
    agentCount,
    skillCount,
    durationMs: Date.now() - startedAt,
  };

  await setSyncCursor(ctx, cursor);

  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "done",
      status: "complete",
      message: `Sync complete: ${agentCount} agents, ${skillCount} skills in ${cursor.durationMs}ms`,
      cursor,
    });
    ctx.streams.close(STREAM_CHANNELS.syncProgress);
    openStreams.delete(STREAM_CHANNELS.syncProgress);
  }

  ctx.logger.info("ClawNet sync complete", {
    agentCount,
    skillCount,
    durationMs: cursor.durationMs,
  });

  return cursor;
}

// ---------------------------------------------------------------------------
// Registration: Jobs
// ---------------------------------------------------------------------------

function registerJobHandlers(ctx: PluginContext): void {
  ctx.jobs.register(JOB_KEYS.sync, async (job: PluginJobContext) => {
    ctx.logger.info("Starting scheduled ClawNet sync", {
      runId: job.runId,
      trigger: job.trigger,
    });

    try {
      const cursor = await performSync(ctx, false);
      ctx.logger.info("Scheduled sync completed", {
        runId: job.runId,
        agentCount: cursor.agentCount,
        skillCount: cursor.skillCount,
        durationMs: cursor.durationMs,
      });
    } catch (error) {
      ctx.logger.error("Scheduled sync failed", {
        runId: job.runId,
        error: summarizeError(error),
      });
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Registration: Events
// ---------------------------------------------------------------------------

function registerEventHandlers(ctx: PluginContext): void {
  ctx.events.on("agent.status_changed", async (event: PluginEvent) => {
    ctx.logger.info("Agent status changed", {
      agentId: event.entityId,
      payload: event.payload,
    });

    // Push real-time update to fleet-status stream for UI consumption
    ctx.streams.emit(STREAM_CHANNELS.fleetStatus, {
      type: "agent-status-changed",
      agentId: event.entityId,
      companyId: event.companyId,
      payload: event.payload,
      occurredAt: event.occurredAt,
    });
  });

  ctx.events.on("agent.created", async (event: PluginEvent) => {
    ctx.logger.info("New agent created", {
      agentId: event.entityId,
      companyId: event.companyId,
    });

    // Check if the new agent matches a ClawNet template
    if (!event.entityId) return;

    const agent = await ctx.agents.get(event.entityId, event.companyId);
    if (!agent) return;

    const clawnetAgents = await ctx.entities.list({
      entityType: ENTITY_TYPES.agent,
      limit: 200,
    });

    const matchingTemplate = clawnetAgents.find((entity) => {
      const data = entity.data as Record<string, unknown>;
      return data.name === agent.name || data.displayName === agent.name;
    });

    if (matchingTemplate) {
      ctx.logger.info("New agent matches ClawNet template", {
        agentId: event.entityId,
        templateId: matchingTemplate.externalId,
        templateTitle: matchingTemplate.title,
      });

      // Auto-link the Paperclip agent to the ClawNet template
      await ctx.state.set(
        {
          scopeKind: "agent",
          scopeId: event.entityId,
          stateKey: STATE_KEYS.clawnetLink,
        },
        {
          clawnetExternalId: matchingTemplate.externalId,
          linkedAt: new Date().toISOString(),
          autoLinked: true,
        },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Registration: Data handlers (for UI via usePluginData)
// ---------------------------------------------------------------------------

function registerDataHandlers(ctx: PluginContext): void {
  // List synced ClawNet agent entities for the marketplace UI
  ctx.data.register(DATA_KEYS.clawnetAgents, async (params) => {
    const { search, limit } = getListParams(params);

    const entities = await ctx.entities.list({
      entityType: ENTITY_TYPES.agent,
      limit,
      offset: 0,
    });

    // Client-side search filtering (entities.list does not support text search)
    if (search) {
      const term = search.toLowerCase();
      return entities.filter((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
        return titleMatch || nameMatch || descMatch;
      });
    }

    return entities;
  });

  // List synced ClawNet skill entities
  ctx.data.register(DATA_KEYS.clawnetSkills, async (params) => {
    const { search, limit } = getListParams(params);

    const entities = await ctx.entities.list({
      entityType: ENTITY_TYPES.skill,
      limit,
      offset: 0,
    });

    if (search) {
      const term = search.toLowerCase();
      return entities.filter((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
        return titleMatch || nameMatch || descMatch;
      });
    }

    return entities;
  });

  // Return last sync time, counts from ctx.state
  ctx.data.register(DATA_KEYS.syncStatus, async () => {
    const cursor = await getSyncCursor(ctx);
    return {
      lastSyncAt: cursor?.lastSyncAt ?? null,
      agentCount: cursor?.agentCount ?? 0,
      skillCount: cursor?.skillCount ?? 0,
      durationMs: cursor?.durationMs ?? 0,
    };
  });

  // List Paperclip agents cross-referenced with ClawNet entities
  ctx.data.register(DATA_KEYS.fleetSummary, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!companyId) {
      throw new Error("companyId is required");
    }

    const [paperclipAgents, clawnetEntities] = await Promise.all([
      ctx.agents.list({ companyId, limit: 200, offset: 0 }),
      ctx.entities.list({
        entityType: ENTITY_TYPES.agent,
        limit: 200,
        offset: 0,
      }),
    ]);

    // Cross-reference via state links
    const fleetEntries = await Promise.all(
      paperclipAgents.map(async (agent) => {
        const linkState = (await ctx.state.get({
          scopeKind: "agent",
          scopeId: agent.id,
          stateKey: STATE_KEYS.clawnetLink,
        })) as {
          clawnetExternalId: string;
          linkedAt: string;
          autoLinked: boolean;
        } | null;

        const clawnetMatch = linkState
          ? clawnetEntities.find((e) => e.externalId === linkState.clawnetExternalId)
          : null;

        return {
          paperclipAgent: {
            id: agent.id,
            name: agent.name,
            status: agent.status,
            role: agent.role,
          },
          clawnetLink: linkState,
          clawnetTemplate: clawnetMatch
            ? {
                externalId: clawnetMatch.externalId,
                title: clawnetMatch.title,
                data: clawnetMatch.data,
              }
            : null,
        };
      }),
    );

    return {
      totalPaperclipAgents: paperclipAgents.length,
      totalClawnetAgents: clawnetEntities.length,
      linkedCount: fleetEntries.filter((e) => e.clawnetLink !== null).length,
      fleet: fleetEntries,
    };
  });
}

// ---------------------------------------------------------------------------
// Registration: Actions (for UI via usePluginAction)
// ---------------------------------------------------------------------------

function registerActionHandlers(ctx: PluginContext): void {
  // Manually trigger a sync, streaming progress via ctx.streams
  ctx.actions.register(ACTION_KEYS.triggerSync, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!companyId) {
      throw new Error("companyId is required");
    }

    ctx.logger.info("Manual sync triggered", { companyId });

    try {
      const cursor = await performSync(ctx, true);
      return {
        ok: true,
        cursor,
        channel: STREAM_CHANNELS.syncProgress,
      };
    } catch (error) {
      ctx.logger.error("Manual sync failed", { error: summarizeError(error) });
      throw error;
    }
  });

  // Link a Paperclip agent to a ClawNet template via ctx.state
  ctx.actions.register(ACTION_KEYS.linkAgent, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const agentId = typeof params.agentId === "string" ? params.agentId : "";
    const clawnetExternalId = typeof params.clawnetExternalId === "string" ? params.clawnetExternalId : "";

    if (!companyId || !agentId || !clawnetExternalId) {
      throw new Error("companyId, agentId, and clawnetExternalId are all required");
    }

    // Verify the Paperclip agent exists
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    // Verify the ClawNet entity exists
    const clawnetEntities = await ctx.entities.list({
      entityType: ENTITY_TYPES.agent,
      externalId: clawnetExternalId,
      limit: 1,
    });
    if (clawnetEntities.length === 0) {
      throw new Error(`ClawNet agent ${clawnetExternalId} not found in synced entities`);
    }

    await ctx.state.set(
      {
        scopeKind: "agent",
        scopeId: agentId,
        stateKey: STATE_KEYS.clawnetLink,
      },
      {
        clawnetExternalId,
        linkedAt: new Date().toISOString(),
        autoLinked: false,
      },
    );

    ctx.logger.info("Linked Paperclip agent to ClawNet template", {
      agentId,
      clawnetExternalId,
      agentName: agent.name,
      templateTitle: clawnetEntities[0]!.title,
    });

    return {
      ok: true,
      agentId,
      clawnetExternalId,
      agentName: agent.name,
      templateTitle: clawnetEntities[0]!.title,
    };
  });

  // Validate plugin configuration (API URL format, API key resolution)
  ctx.actions.register(ACTION_KEYS.validateConfig, async (_params) => {
    const config = await getConfig(ctx);
    const errors: string[] = [];

    if (config.clawnetApiUrl) {
      try {
        new URL(config.clawnetApiUrl);
      } catch {
        errors.push("Invalid API URL");
      }
    }

    if (config.clawnetApiKey) {
      try {
        await ctx.secrets.resolve(config.clawnetApiKey);
      } catch (e) {
        errors.push("API key resolution failed: " + summarizeError(e));
      }
    } else {
      errors.push("No API key configured");
    }

    return { ok: errors.length === 0, errors };
  });
}

// ---------------------------------------------------------------------------
// Registration: Agent tools
// ---------------------------------------------------------------------------

function registerToolHandlers(ctx: PluginContext): void {
  // Tool: look up a ClawNet agent by slug
  ctx.tools.register(
    TOOL_NAMES.agentLookup,
    {
      displayName: "ClawNet Agent Lookup",
      description:
        "Look up a ClawNet agent by slug or name. Returns the agent profile including skills, model, description, and trust attestations.",
      parametersSchema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The slug or name of the ClawNet agent to look up",
          },
        },
        required: ["slug"],
      },
    },
    async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const { slug } = params as { slug?: string };
      if (!slug) {
        return { error: "slug is required" };
      }

      // Try exact match on externalId first
      const entities = await ctx.entities.list({
        entityType: ENTITY_TYPES.agent,
        externalId: slug,
        limit: 1,
      });

      if (entities.length > 0) {
        const entity = entities[0]!;
        return {
          content: `Found agent: ${entity.title} (${entity.externalId})`,
          data: entity.data,
        };
      }

      // Fallback: fuzzy search by title/name/slug
      const allAgents = await ctx.entities.list({
        entityType: ENTITY_TYPES.agent,
        limit: 200,
      });

      const term = slug.toLowerCase();
      const match = allAgents.find((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const slugMatch = typeof data.slug === "string" && data.slug.toLowerCase().includes(term);
        return titleMatch || nameMatch || slugMatch;
      });

      if (match) {
        return {
          content: `Found agent: ${match.title} (${match.externalId})`,
          data: match.data,
        };
      }

      return {
        error: `No ClawNet agent found matching "${slug}". Run a sync to ensure the registry is up to date.`,
      };
    },
  );

  // Tool: search skills
  ctx.tools.register(
    TOOL_NAMES.skillSearch,
    {
      displayName: "ClawNet Skill Search",
      description:
        "Search for available skills in the ClawNet registry. Returns matching skills with descriptions and compatibility info.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search term to find skills by name or description",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10)",
          },
        },
        required: ["query"],
      },
    },
    async (params, _runCtx: ToolRunContext): Promise<ToolResult> => {
      const { query, limit: maxResults } = params as { query?: string; limit?: number };
      if (!query) {
        return { error: "query is required" };
      }

      const resultLimit = Math.min(maxResults ?? 10, 50);
      const allSkills = await ctx.entities.list({
        entityType: ENTITY_TYPES.skill,
        limit: 200,
      });

      const term = query.toLowerCase();
      const matches = allSkills
        .filter((entity) => {
          const titleMatch = entity.title?.toLowerCase().includes(term);
          const data = entity.data as Record<string, unknown>;
          const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
          const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
          return titleMatch || nameMatch || descMatch;
        })
        .slice(0, resultLimit);

      if (matches.length === 0) {
        return {
          content: `No skills found matching "${query}".`,
          data: { results: [], total: 0 },
        };
      }

      const results = matches.map((entity) => ({
        name: entity.title,
        externalId: entity.externalId,
        data: entity.data,
      }));

      return {
        content: `Found ${results.length} skill(s) matching "${query}": ${results.map((r) => r.name).join(", ")}`,
        data: { results, total: results.length },
      };
    },
  );

  // Tool: fleet overview summary
  ctx.tools.register(
    TOOL_NAMES.fleetOverview,
    {
      displayName: "ClawNet Fleet Overview",
      description:
        "Get a summary of all ClawNet bots in the registry including counts, status breakdown, and sync info.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    async (_params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const [agents, skills, cursor, paperclipAgents] = await Promise.all([
        ctx.entities.list({ entityType: ENTITY_TYPES.agent, limit: 200 }),
        ctx.entities.list({ entityType: ENTITY_TYPES.skill, limit: 200 }),
        getSyncCursor(ctx),
        ctx.agents.list({ companyId: runCtx.companyId, limit: 200, offset: 0 }),
      ]);

      // Group ClawNet agents by status
      const statusCounts: Record<string, number> = {};
      for (const agent of agents) {
        const status = agent.status || "unknown";
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }

      const summary = {
        clawnetAgents: agents.length,
        clawnetSkills: skills.length,
        paperclipAgents: paperclipAgents.length,
        statusBreakdown: statusCounts,
        lastSync: cursor?.lastSyncAt ?? "never",
        lastSyncDurationMs: cursor?.durationMs ?? null,
      };

      return {
        content: [
          `Fleet overview: ${agents.length} ClawNet agents, ${skills.length} skills, ${paperclipAgents.length} Paperclip agents.`,
          `Last sync: ${cursor?.lastSyncAt ?? "never"}.`,
          `Status breakdown: ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        ].join(" "),
        data: summary,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.logger.info("ClawNet plugin starting setup");

    // All registrations are synchronous within setup -- no deferred registration
    registerJobHandlers(ctx);
    registerEventHandlers(ctx);
    registerDataHandlers(ctx);
    registerActionHandlers(ctx);
    registerToolHandlers(ctx);

    ctx.logger.info("ClawNet plugin setup complete");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    if (!ctx) {
      return { status: "error", message: "Plugin context not initialized" };
    }

    try {
      const cursor = await getSyncCursor(ctx);
      if (!cursor) {
        return {
          status: "degraded",
          message: "No sync has been performed yet",
          details: { lastSync: null },
        };
      }

      // Degraded if last sync was more than 30 minutes ago
      const lastSyncAge = Date.now() - new Date(cursor.lastSyncAt).getTime();
      const thirtyMinutes = 30 * 60 * 1000;

      if (lastSyncAge > thirtyMinutes) {
        return {
          status: "degraded",
          message: `Last sync was ${Math.round(lastSyncAge / 60000)} minutes ago`,
          details: {
            lastSync: cursor.lastSyncAt,
            agentCount: cursor.agentCount,
            skillCount: cursor.skillCount,
            syncAgeMs: lastSyncAge,
          },
        };
      }

      return {
        status: "ok",
        message: `Healthy. ${cursor.agentCount} agents, ${cursor.skillCount} skills synced.`,
        details: {
          lastSync: cursor.lastSyncAt,
          agentCount: cursor.agentCount,
          skillCount: cursor.skillCount,
          durationMs: cursor.durationMs,
        },
      };
    } catch (error) {
      return {
        status: "error",
        message: `Health check failed: ${summarizeError(error)}`,
      };
    }
  },

  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const typed = config as ClawNetConfig;

    // Validate clawnetApiUrl
    if (typed.clawnetApiUrl !== undefined) {
      if (typeof typed.clawnetApiUrl !== "string") {
        errors.push("clawnetApiUrl must be a string");
      } else {
        try {
          const url = new URL(typed.clawnetApiUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            errors.push("clawnetApiUrl must use http or https protocol");
          }

          // SSRF: reject private/internal hostnames
          const hostname = url.hostname;
          if (
            hostname === "localhost" ||
            hostname.startsWith("127.") ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254.") ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            hostname.endsWith(".internal") ||
            hostname.endsWith(".local")
          ) {
            errors.push("clawnetApiUrl must not point to a private or internal address");
          }
        } catch {
          errors.push("clawnetApiUrl is not a valid URL");
        }
      }
    }

    // Validate clawnetApiKey (must be a secret reference string)
    if (typed.clawnetApiKey !== undefined) {
      if (typeof typed.clawnetApiKey !== "string") {
        errors.push("clawnetApiKey must be a string (secret reference)");
      } else if (typed.clawnetApiKey.length === 0) {
        errors.push("clawnetApiKey cannot be empty");
      }
    }

    // Attempt to resolve the secret to verify it works
    if (currentContext && typed.clawnetApiKey && typeof typed.clawnetApiKey === "string") {
      try {
        const resolved = await currentContext.secrets.resolve(typed.clawnetApiKey);
        if (!resolved || resolved.length === 0) {
          errors.push("clawnetApiKey secret reference resolved to an empty value");
        }
      } catch (error) {
        errors.push(`clawnetApiKey secret resolution failed: ${summarizeError(error)}`);
      }
    }

    if (!typed.clawnetApiUrl) {
      warnings.push(`clawnetApiUrl not set; will default to ${DEFAULT_CONFIG.clawnetApiUrl}`);
    }

    return {
      ok: errors.length === 0,
      warnings,
      errors,
    };
  },

  async onShutdown() {
    // Close any open streams during graceful shutdown
    if (currentContext) {
      for (const channel of openStreams) {
        try {
          currentContext.streams.close(channel);
        } catch {
          // Best-effort cleanup
        }
      }
      openStreams.clear();
    }

    currentContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
