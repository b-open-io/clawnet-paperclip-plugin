import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
  type ToolResult,
  type ToolRunContext,
  type Agent,
} from "@paperclipai/plugin-sdk";
import type { PluginHealthDiagnostics, PluginConfigValidationResult, PluginEntityRecord } from "@paperclipai/plugin-sdk";
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
  orgCount: number;
  appCount: number;
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

async function resolveApiKey(ctx: PluginContext, config: ClawNetConfig): Promise<string | undefined> {
  if (!config.clawnetApiKey) {
    return undefined; // API key is optional for read-only operations (listing/syncing)
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
  // companyId is optional for entity listing (entities are instance-scoped)
  return { companyId, search, page, limit };
}

// ---------------------------------------------------------------------------
// Skill distribution
// ---------------------------------------------------------------------------

async function distributeClawNetSkills(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
): Promise<void> {
  // Read clawnet-link state — if agent is not linked, nothing to distribute
  const linkState = (await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: STATE_KEYS.clawnetLink,
  })) as { clawnetExternalId: string } | null;

  if (!linkState) return;

  // Idempotent guard — skip if skills were already distributed
  const alreadyDistributed = await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: STATE_KEYS.skillsDistributed,
  });

  if (alreadyDistributed) return;

  // Look up the ClawNet template entity to extract skills
  const templateEntities = await ctx.entities.list({
    entityType: ENTITY_TYPES.agent,
    externalId: linkState.clawnetExternalId,
    limit: 1,
  });

  const template = templateEntities[0];
  if (!template) return;

  const templateData = template.data as Record<string, unknown>;
  const skills = Array.isArray(templateData.skills) ? (templateData.skills as string[]) : [];

  if (skills.length === 0) return;

  // Invoke the agent to configure its skills
  const skillList = skills.join(", ");
  await ctx.agents.invoke(agentId, companyId, {
    prompt: `Configure your skills: ${skillList}`,
    reason: "ClawNet skill distribution",
  });

  ctx.logger.info("Distributed ClawNet skills to agent", {
    agentId,
    companyId,
    templateSlug: linkState.clawnetExternalId,
    skills,
  });

  // Mark distribution as complete (idempotent guard for future calls)
  await ctx.state.set(
    {
      scopeKind: "agent",
      scopeId: agentId,
      stateKey: STATE_KEYS.skillsDistributed,
    },
    {
      distributedAt: new Date().toISOString(),
      skills,
      templateSlug: linkState.clawnetExternalId,
    },
  );
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

  // --- Sync organizations ---
  let orgCount = 0;
  try {
    if (streamProgress) {
      ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
        phase: "organizations",
        status: "fetching",
        message: "Fetching organizations from ClawNet registry...",
      });
    }

    let orgCursor: string | undefined;
    do {
      const orgResponse = await client.listOrganizations({ cursor: orgCursor });
      for (const org of orgResponse.organizations) {
        await ctx.entities.upsert({
          entityType: ENTITY_TYPES.organization,
          scopeKind: "instance",
          externalId: org.slug || org._id,
          title: org.displayName || org.name,
          status: org.deleted ? "deleted" : "active",
          data: org as unknown as Record<string, unknown>,
        });
        orgCount++;
      }
      orgCursor = orgResponse.hasMore ? orgResponse.cursor : undefined;
    } while (orgCursor);

    if (streamProgress) {
      ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
        phase: "organizations",
        status: "complete",
        message: `Synced ${orgCount} organizations`,
        count: orgCount,
      });
    }
  } catch (err) {
    // Organizations endpoint may not exist on older registries
    ctx.logger.warn("Organization sync skipped", {
      reason: summarizeError(err),
    });
  }

  // --- Sync apps ---
  let appCount = 0;
  try {
    if (streamProgress) {
      ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
        phase: "apps",
        status: "fetching",
        message: "Fetching apps from ClawNet registry...",
      });
    }

    let appCursor: string | undefined;
    do {
      const appResponse = await client.listApps({ cursor: appCursor });
      for (const app of appResponse.apps) {
        await ctx.entities.upsert({
          entityType: ENTITY_TYPES.app,
          scopeKind: "instance",
          externalId: app.slug || app._id,
          title: app.displayName || app.name,
          status: app.deleted ? "deleted" : "active",
          data: app as unknown as Record<string, unknown>,
        });
        appCount++;
      }
      appCursor = appResponse.hasMore ? appResponse.cursor : undefined;
    } while (appCursor);

    if (streamProgress) {
      ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
        phase: "apps",
        status: "complete",
        message: `Synced ${appCount} apps`,
        count: appCount,
      });
    }
  } catch (err) {
    ctx.logger.warn("App sync skipped", { reason: summarizeError(err) });
  }

  // --- Persist cursor ---
  const cursor: SyncCursor = {
    lastSyncAt: new Date().toISOString(),
    agentCount,
    skillCount,
    orgCount,
    appCount,
    durationMs: Date.now() - startedAt,
  };

  await setSyncCursor(ctx, cursor);

  if (streamProgress) {
    ctx.streams.emit(STREAM_CHANNELS.syncProgress, {
      phase: "done",
      status: "complete",
      message: `Sync complete: ${agentCount} agents, ${skillCount} skills, ${orgCount} organizations, ${appCount} apps in ${cursor.durationMs}ms`,
      cursor,
    });
    ctx.streams.close(STREAM_CHANNELS.syncProgress);
    openStreams.delete(STREAM_CHANNELS.syncProgress);
  }

  ctx.logger.info("ClawNet sync complete", {
    agentCount,
    skillCount,
    orgCount,
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
        orgCount: cursor.orgCount,
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

    // Distribute skills when a linked agent transitions to idle (hire approved)
    const newStatus = (event.payload as Record<string, unknown>)?.newStatus;
    if (newStatus === "idle" && event.entityId) {
      await distributeClawNetSkills(ctx, event.entityId, event.companyId);
    }
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

      // Distribute template skills immediately after auto-linking
      await distributeClawNetSkills(ctx, event.entityId, event.companyId);
    }
  });
}

// ---------------------------------------------------------------------------
// Registration: Data handlers (for UI via usePluginData)
// ---------------------------------------------------------------------------

function registerDataHandlers(ctx: PluginContext): void {
  // List synced ClawNet agent entities for the marketplace UI
  ctx.data.register(DATA_KEYS.clawnetAgents, async (params) => {
    const { search, page, limit } = getListParams(params);

    let entities = await ctx.entities.list({
      entityType: ENTITY_TYPES.agent,
      limit,
      offset: 0,
    });

    // Client-side search filtering (entities.list does not support text search)
    if (search) {
      const term = search.toLowerCase();
      entities = entities.filter((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
        return titleMatch || nameMatch || descMatch;
      });
    }

    // Transform entities into the UI's expected ClawNetAgent shape
    const agents = entities.map((entity) => {
      const d = entity.data as Record<string, unknown>;
      return {
        id: entity.externalId ?? entity.id,
        slug: (d.slug as string) ?? entity.externalId ?? "",
        displayName: entity.title ?? (d.displayName as string) ?? (d.name as string) ?? "",
        description: (d.description as string) ?? null,
        model: (d.model as string) ?? null,
        color: (d.color as string) ?? null,
        icon: (d.icon as string) ?? null,
        starCount: (d.starCount as number) ?? 0,
        trustScore: null, // Not yet available from ClawNet
        attestations: [], // Not yet available from ClawNet
        skills: Array.isArray(d.skills) ? d.skills : [],
        createdAt: entity.createdAt,
      };
    });

    return { agents, total: agents.length, page, limit };
  });

  // List synced ClawNet skill entities
  ctx.data.register(DATA_KEYS.clawnetSkills, async (params) => {
    const { search, limit } = getListParams(params);

    let entities = await ctx.entities.list({
      entityType: ENTITY_TYPES.skill,
      limit,
      offset: 0,
    });

    if (search) {
      const term = search.toLowerCase();
      entities = entities.filter((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
        return titleMatch || nameMatch || descMatch;
      });
    }

    // Transform entities into the UI's expected ClawNetSkill shape
    const skills = entities.map((entity) => {
      const d = entity.data as Record<string, unknown>;
      return {
        id: entity.externalId ?? entity.id,
        slug: (d.slug as string) ?? entity.externalId ?? "",
        displayName: entity.title ?? (d.displayName as string) ?? (d.name as string) ?? "",
        description: (d.description as string) ?? null,
        category: (d.category as string) ?? null,
        starCount: (d.starCount as number) ?? 0,
      };
    });

    return { skills, total: skills.length };
  });

  // List synced ClawNet organization entities
  ctx.data.register(DATA_KEYS.clawnetOrganizations, async (params) => {
    const { search, limit } = getListParams(params);

    let entities = await ctx.entities.list({
      entityType: ENTITY_TYPES.organization,
      limit,
      offset: 0,
    });

    if (search) {
      const term = search.toLowerCase();
      entities = entities.filter((entity) => {
        const titleMatch = entity.title?.toLowerCase().includes(term);
        const data = entity.data as Record<string, unknown>;
        const nameMatch = typeof data.name === "string" && data.name.toLowerCase().includes(term);
        const descMatch = typeof data.description === "string" && data.description.toLowerCase().includes(term);
        return titleMatch || nameMatch || descMatch;
      });
    }

    // Transform entities into the UI's expected ClawNetOrganization shape
    const organizations = entities.map((entity) => {
      const d = entity.data as Record<string, unknown>;
      return {
        id: entity.externalId ?? entity.id,
        slug: (d.slug as string) ?? entity.externalId ?? "",
        displayName: entity.title ?? (d.displayName as string) ?? (d.name as string) ?? "",
        description: (d.description as string) ?? null,
        agents: Array.isArray(d.agents) ? d.agents : [],
        skills: Array.isArray(d.skills) ? d.skills : [],
        color: (d.color as string) ?? null,
        icon: (d.icon as string) ?? null,
        starCount: (d.starCount as number) ?? 0,
        createdAt: entity.createdAt,
      };
    });

    return { organizations, total: organizations.length };
  });

  // Return last sync time, counts from ctx.state
  ctx.data.register(DATA_KEYS.syncStatus, async () => {
    const cursor = await getSyncCursor(ctx);
    return {
      lastSyncAt: cursor?.lastSyncAt ?? null,
      agentCount: cursor?.agentCount ?? 0,
      skillCount: cursor?.skillCount ?? 0,
      orgCount: cursor?.orgCount ?? 0,
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

        let clawnetTemplate = null;
        if (clawnetMatch) {
          const d = clawnetMatch.data as Record<string, unknown>;
          clawnetTemplate = {
            id: clawnetMatch.externalId ?? clawnetMatch.id,
            slug: (d.slug as string) ?? clawnetMatch.externalId ?? "",
            displayName: clawnetMatch.title ?? (d.displayName as string) ?? (d.name as string) ?? "",
            description: (d.description as string) ?? null,
            model: (d.model as string) ?? null,
            color: (d.color as string) ?? null,
            starCount: (d.starCount as number) ?? 0,
            trustScore: null,
            attestations: [],
            skills: Array.isArray(d.skills) ? d.skills : [],
            createdAt: clawnetMatch.createdAt,
          };
        }

        const paperclipAgent: Pick<Agent, "id" | "name" | "status" | "role"> = {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role,
        };

        // Read skills-distributed state for this agent
        const skillsDistributedState = (await ctx.state.get({
          scopeKind: "agent",
          scopeId: agent.id,
          stateKey: STATE_KEYS.skillsDistributed,
        })) as {
          distributedAt: string;
          skills: string[];
          templateSlug: string;
        } | null;

        return {
          paperclipAgent,
          clawnetLink: linkState,
          clawnetTemplate,
          skillsDistributed: skillsDistributedState
            ? { distributedAt: skillsDistributedState.distributedAt, skills: skillsDistributedState.skills }
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

  // List routine-execution issues grouped by agent
  ctx.data.register(DATA_KEYS.agentRoutines, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    if (!companyId) {
      throw new Error("companyId is required");
    }

    try {
      const paperclipAgents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });

      // For each ClawNet-linked agent, fetch recent issues and filter for routine_execution origin
      const executionIssuesByAgent: Record<
        string,
        { issueId: string; title: string; status: string; originId: string | null }[]
      > = {};

      await Promise.all(
        paperclipAgents.map(async (agent) => {
          // Only check agents that are linked to a ClawNet template
          const linkState = await ctx.state.get({
            scopeKind: "agent",
            scopeId: agent.id,
            stateKey: STATE_KEYS.clawnetLink,
          });

          if (!linkState) return;

          const issues = await ctx.issues.list({
            companyId,
            assigneeAgentId: agent.id,
            limit: 50,
          });

          const routineIssues = issues
            .filter((issue) => issue.originKind === "routine_execution")
            .map((issue) => ({
              issueId: issue.id,
              title: issue.title,
              status: issue.status,
              originId: issue.originId ?? null,
            }));

          if (routineIssues.length > 0) {
            executionIssuesByAgent[agent.id] = routineIssues;
          }
        }),
      );

      return { executionIssuesByAgent, available: true };
    } catch (error) {
      ctx.logger.warn("Failed to fetch routine activity", {
        error: summarizeError(error),
      });
      return { executionIssuesByAgent: {}, available: false };
    }
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

  // Hire a ClawNet agent by invoking the CEO directly (or creating an issue)
  ctx.actions.register(ACTION_KEYS.hireAgent, async (params) => {
    const companyId = typeof params.companyId === "string" ? params.companyId : "";
    const slug = typeof params.slug === "string" ? params.slug : "";
    const displayName = typeof params.displayName === "string" ? params.displayName : "";
    const model = typeof params.model === "string" ? params.model : null;
    const color = typeof params.color === "string" ? params.color : null;
    const description = typeof params.description === "string" ? params.description : null;
    const skills = Array.isArray(params.skills) ? (params.skills as string[]) : [];

    if (!companyId || !slug || !displayName) {
      throw new Error("companyId, slug, and displayName are required");
    }

    // Build the hire prompt with registry reference
    const config = await getConfig(ctx);
    const registryBase = config.clawnetApiUrl || DEFAULT_CONFIG.clawnetApiUrl;
    const agentApiUrl = `${registryBase}/api/v1/agents/${encodeURIComponent(slug)}`;

    const promptLines = [
      `Hire a new agent from the ClawNet on-chain registry.`,
      ``,
      `Agent summary:`,
      `- Name: ${displayName}`,
      `- Slug: ${slug}`,
      model ? `- Model: ${model}` : null,
      color ? `- Color: ${color}` : null,
      description ? `- Role: ${description}` : null,
      skills.length > 0 ? `- Skills: ${skills.join(", ")}` : null,
      ``,
      `Full agent definition (system prompt, skills, tools, version history):`,
      `  curl -s ${agentApiUrl}`,
      ``,
      `Steps:`,
      `1. Fetch the full agent definition: curl -s ${agentApiUrl}`,
      `2. Create the agent via POST /api/companies/${companyId}/agent-hires with:`,
      `   - name: "${displayName}"`,
      `   - adapterType: "claude_local"`,
      `   - role: "general"`,
      model ? `   - model: "${model}"` : null,
      color ? `   - color: "${color}"` : null,
      `3. After creation, set the agent's instructions using the systemPrompt from the registry response:`,
      `   PUT /api/companies/${companyId}/agents/{agentId}/instructions/files`,
      `   Body: { "path": "AGENTS.md", "content": <systemPrompt from registry> }`,
      `4. Install the agent's skills: the registry response includes a skills array — use clawnet add <slug> for each`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    // Find the CEO agent
    const agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
    const ceo = agents.find((a) => a.role === "ceo");

    if (ceo) {
      const result = await ctx.agents.invoke(ceo.id, companyId, {
        prompt: promptLines,
        reason: `Hire agent: ${displayName} (${slug})`,
      });

      ctx.logger.info("Invoked CEO to hire agent", {
        ceoId: ceo.id,
        ceoName: ceo.name,
        runId: result.runId,
        slug,
        displayName,
      });

      return {
        ok: true,
        method: "invoke" as const,
        runId: result.runId,
        agentName: ceo.name,
      };
    }

    // Fallback: create an issue if no CEO agent found
    const issue = await ctx.issues.create({
      companyId,
      title: `Hire agent: ${displayName} (${slug})`,
      description: promptLines,
      priority: "medium",
    });

    ctx.logger.warn("No CEO agent found, created hire issue instead", {
      issueId: issue.id,
      slug,
      displayName,
    });

    return {
      ok: true,
      method: "issue" as const,
      issueId: issue.id,
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

  // Tool: hire a ClawNet agent (for CEO or agents with hiring permissions)
  ctx.tools.register(
    TOOL_NAMES.hireClawnetAgent,
    {
      displayName: "Hire ClawNet Agent",
      description:
        "Hire an agent from the ClawNet registry into this Paperclip company. Looks up the agent by slug and returns the hire payload for the agent-hires API.",
      parametersSchema: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "The ClawNet agent slug to hire",
          },
        },
        required: ["slug"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const { slug } = params as { slug?: string };
      if (!slug) {
        return { error: "slug is required" };
      }

      // Look up the ClawNet agent entity
      const entities = await ctx.entities.list({
        entityType: ENTITY_TYPES.agent,
        externalId: slug,
        limit: 1,
      });

      let entity: PluginEntityRecord | undefined = entities[0];
      if (!entity) {
        // Fuzzy search fallback
        const allAgents = await ctx.entities.list({
          entityType: ENTITY_TYPES.agent,
          limit: 200,
        });
        const term = slug.toLowerCase();
        entity = allAgents.find((e) => {
          const d = e.data as Record<string, unknown>;
          return (
            e.title?.toLowerCase().includes(term) ||
            (typeof d.slug === "string" && d.slug.toLowerCase().includes(term)) ||
            (typeof d.name === "string" && d.name.toLowerCase().includes(term))
          );
        });
      }

      if (!entity) {
        return {
          error: `No ClawNet agent found matching "${slug}". Run a sync to ensure the registry is up to date.`,
        };
      }

      const d = entity.data as Record<string, unknown>;
      const hirePayload = {
        name: entity.title ?? (d.displayName as string) ?? (d.name as string) ?? slug,
        slug: (d.slug as string) ?? entity.externalId ?? slug,
        model: (d.model as string) ?? null,
        color: (d.color as string) ?? null,
        description: (d.description as string) ?? null,
        skills: Array.isArray(d.skills) ? d.skills : [],
        role: "general",
        adapterType: "claude_local",
        companyId: runCtx.companyId,
      };

      return {
        content: `Found ClawNet agent "${hirePayload.name}" (${hirePayload.slug}). Use POST /api/companies/${runCtx.companyId}/agent-hires with this payload to hire them.`,
        data: hirePayload,
      };
    },
  );

  // Tool: link a Paperclip agent to a ClawNet template
  ctx.tools.register(
    TOOL_NAMES.linkAgent,
    {
      displayName: "Link Agent to ClawNet Template",
      description:
        "Link an existing Paperclip agent to a ClawNet registry template so the fleet overview tracks the relationship.",
      parametersSchema: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description: "The Paperclip agent UUID to link",
          },
          clawnetSlug: {
            type: "string",
            description: "The ClawNet agent slug to link to",
          },
        },
        required: ["agentId", "clawnetSlug"],
      },
    },
    async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
      const { agentId, clawnetSlug } = params as { agentId?: string; clawnetSlug?: string };
      if (!agentId || !clawnetSlug) {
        return { error: "agentId and clawnetSlug are required" };
      }

      // Verify the Paperclip agent exists
      const agent = await ctx.agents.get(agentId, runCtx.companyId);
      if (!agent) {
        return { error: `Agent ${agentId} not found` };
      }

      // Resolve the ClawNet slug to an entity
      let clawnetEntity: PluginEntityRecord | undefined;
      const exact = await ctx.entities.list({
        entityType: ENTITY_TYPES.agent,
        externalId: clawnetSlug,
        limit: 1,
      });
      clawnetEntity = exact[0];

      if (!clawnetEntity) {
        const all = await ctx.entities.list({ entityType: ENTITY_TYPES.agent, limit: 200 });
        const term = clawnetSlug.toLowerCase();
        clawnetEntity = all.find((e) => {
          const d = e.data as Record<string, unknown>;
          return (
            (typeof d.slug === "string" && d.slug.toLowerCase() === term) ||
            e.title?.toLowerCase() === term
          );
        });
      }

      if (!clawnetEntity) {
        return { error: `ClawNet agent "${clawnetSlug}" not found in synced entities. Run a sync first.` };
      }

      // Persist the link
      await ctx.state.set(
        {
          scopeKind: "agent",
          scopeId: agentId,
          stateKey: STATE_KEYS.clawnetLink,
        },
        {
          clawnetExternalId: clawnetEntity.externalId,
          linkedAt: new Date().toISOString(),
          autoLinked: false,
        },
      );

      return {
        content: `Linked Paperclip agent "${agent.name}" to ClawNet template "${clawnetEntity.title}" (${clawnetEntity.externalId}).`,
        data: {
          agentId,
          agentName: agent.name,
          clawnetExternalId: clawnetEntity.externalId,
          templateTitle: clawnetEntity.title,
        },
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
            orgCount: cursor.orgCount ?? 0,
            syncAgeMs: lastSyncAge,
          },
        };
      }

      return {
        status: "ok",
        message: `Healthy. ${cursor.agentCount} agents, ${cursor.skillCount} skills, ${cursor.orgCount ?? 0} organizations synced.`,
        details: {
          lastSync: cursor.lastSyncAt,
          agentCount: cursor.agentCount,
          skillCount: cursor.skillCount,
          orgCount: cursor.orgCount ?? 0,
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

    // Validate clawnetApiKey if provided (optional — not needed for read-only sync)
    if (typed.clawnetApiKey && typeof typed.clawnetApiKey === "string" && typed.clawnetApiKey.length > 0) {
      // Attempt to resolve the secret to verify it works
      if (currentContext) {
        try {
          const resolved = await currentContext.secrets.resolve(typed.clawnetApiKey);
          if (!resolved || resolved.length === 0) {
            warnings.push("clawnetApiKey secret reference resolved to an empty value");
          }
        } catch (error) {
          warnings.push(`clawnetApiKey secret resolution failed: ${summarizeError(error)}`);
        }
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
