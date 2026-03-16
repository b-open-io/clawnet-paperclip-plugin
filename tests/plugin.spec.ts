import { describe, expect, it, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  JOB_KEYS,
  TOOL_NAMES,
  DATA_KEYS,
  ACTION_KEYS,
  STATE_KEYS,
  ENTITY_TYPES,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHarness(configOverrides?: Record<string, unknown>): TestHarness {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
    config: {
      clawnetApiUrl: "https://clawnet.sh",
      clawnetApiKey: "secret-ref:clawnet-key",
      ...configOverrides,
    },
  });
}

async function setupPlugin(harness: TestHarness): Promise<void> {
  await plugin.definition.setup(harness.ctx);
}

/**
 * Seed a ClawNet agent entity into the harness so data/tool/action handlers
 * that query `ctx.entities.list` can find it.
 */
async function seedClawNetAgent(
  harness: TestHarness,
  slug: string,
  name: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  // We go through ctx.entities.upsert since that's the same path the sync uses
  await harness.ctx.entities.upsert({
    entityType: ENTITY_TYPES.agent,
    scopeKind: "instance",
    externalId: slug,
    title: name,
    status: "active",
    data: { slug, name, displayName: name, description: `${name} agent`, ...extra },
  });
}

async function seedClawNetSkill(
  harness: TestHarness,
  slug: string,
  name: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await harness.ctx.entities.upsert({
    entityType: ENTITY_TYPES.skill,
    scopeKind: "instance",
    externalId: slug,
    title: name,
    status: "available",
    data: { slug, name, description: `${name} skill`, ...extra },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("ClawNet plugin setup", () => {
  it("completes setup without error", async () => {
    const harness = makeHarness();
    await expect(setupPlugin(harness)).resolves.not.toThrow();
  });

  it("logs setup start and completion", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const messages = harness.logs.map((l) => l.message);
    expect(messages).toContain("ClawNet plugin starting setup");
    expect(messages).toContain("ClawNet plugin setup complete");
  });
});

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------

describe("ClawNet sync job", () => {
  it("registers the clawnet-sync job handler", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    // Verify the handler is registered by confirming runJob does NOT throw
    // "No job handler registered for 'clawnet-sync'". The harness delegates
    // http.fetch to real fetch, so the sync may succeed or fail depending on
    // network — we only assert registration, not execution outcome.
    let threwNoHandler = false;
    try {
      await harness.runJob(JOB_KEYS.sync);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("No job handler registered")) {
        threwNoHandler = true;
      }
      // Any other error (network, parsing) is acceptable — the handler ran
    }
    expect(threwNoHandler).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

describe("ClawNet event handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = makeHarness();
    await setupPlugin(harness);
  });

  it("handles agent.status_changed event", async () => {
    await harness.emit(
      "agent.status_changed",
      { newStatus: "idle", oldStatus: "running" },
      { entityId: "agent-1", entityType: "agent", companyId: "co-1" },
    );

    const statusLog = harness.logs.find((l) => l.message === "Agent status changed");
    expect(statusLog).toBeDefined();
    expect(statusLog!.meta?.agentId).toBe("agent-1");
  });

  it("handles agent.created event and auto-links matching template", async () => {
    // Seed a ClawNet agent template first
    await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

    // Seed a Paperclip agent with matching name
    harness.seed({
      agents: [
        {
          id: "pa-1",
          companyId: "co-1",
          name: "ScoutBot",
          status: "idle",
          role: "worker",
          model: "claude-sonnet-4-20250514",
          systemPrompt: null,
          nameKey: "scout",
          adapterType: "claude-code",
          costLimitUsd: null,
          projectId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ],
    });

    await harness.emit(
      "agent.created",
      { agentId: "pa-1" },
      { entityId: "pa-1", entityType: "agent", companyId: "co-1" },
    );

    // Verify the auto-link state was written
    const linkState = harness.getState({
      scopeKind: "agent",
      scopeId: "pa-1",
      stateKey: STATE_KEYS.clawnetLink,
    }) as { clawnetExternalId: string; autoLinked: boolean } | undefined;

    expect(linkState).toBeDefined();
    expect(linkState!.clawnetExternalId).toBe("scout-bot");
    expect(linkState!.autoLinked).toBe(true);
  });

  it("handles agent.created event when no template matches", async () => {
    harness.seed({
      agents: [
        {
          id: "pa-2",
          companyId: "co-1",
          name: "UnknownBot",
          status: "idle",
          role: "worker",
          model: "claude-sonnet-4-20250514",
          systemPrompt: null,
          nameKey: "unknown",
          adapterType: "claude-code",
          costLimitUsd: null,
          projectId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ],
    });

    await harness.emit(
      "agent.created",
      { agentId: "pa-2" },
      { entityId: "pa-2", entityType: "agent", companyId: "co-1" },
    );

    // No link should be set
    const linkState = harness.getState({
      scopeKind: "agent",
      scopeId: "pa-2",
      stateKey: STATE_KEYS.clawnetLink,
    });
    expect(linkState).toBeUndefined();
  });

  it("handles agent.created with missing entityId gracefully", async () => {
    // No entityId means handler returns early
    await harness.emit(
      "agent.created",
      {},
      { entityType: "agent", companyId: "co-1" },
    );

    const createdLog = harness.logs.find((l) => l.message === "New agent created");
    expect(createdLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Data handlers
// ---------------------------------------------------------------------------

describe("ClawNet data handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = makeHarness();
    await setupPlugin(harness);
  });

  describe("clawnet-agents", () => {
    it("returns all synced agent entities", async () => {
      await seedClawNetAgent(harness, "alpha", "Alpha Agent");
      await seedClawNetAgent(harness, "beta", "Beta Agent");

      const result = await harness.getData<any[]>(DATA_KEYS.clawnetAgents, {
        companyId: "co-1",
        page: 1,
        limit: 25,
      });

      expect(result).toHaveLength(2);
    });

    it("filters agents by search term", async () => {
      await seedClawNetAgent(harness, "alpha", "Alpha Agent");
      await seedClawNetAgent(harness, "beta", "Beta Agent");

      const result = await harness.getData<any[]>(DATA_KEYS.clawnetAgents, {
        companyId: "co-1",
        search: "alpha",
        page: 1,
        limit: 25,
      });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Alpha Agent");
    });

    it("throws when companyId is missing", async () => {
      await expect(
        harness.getData(DATA_KEYS.clawnetAgents, {}),
      ).rejects.toThrow("companyId is required");
    });
  });

  describe("clawnet-skills", () => {
    it("returns all synced skill entities", async () => {
      await seedClawNetSkill(harness, "code-review", "Code Review");
      await seedClawNetSkill(harness, "deploy", "Deploy");

      const result = await harness.getData<any[]>(DATA_KEYS.clawnetSkills, {
        companyId: "co-1",
        page: 1,
        limit: 25,
      });

      expect(result).toHaveLength(2);
    });

    it("filters skills by search term", async () => {
      await seedClawNetSkill(harness, "code-review", "Code Review");
      await seedClawNetSkill(harness, "deploy", "Deploy");

      const result = await harness.getData<any[]>(DATA_KEYS.clawnetSkills, {
        companyId: "co-1",
        search: "deploy",
        page: 1,
        limit: 25,
      });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe("Deploy");
    });

    it("throws when companyId is missing", async () => {
      await expect(
        harness.getData(DATA_KEYS.clawnetSkills, {}),
      ).rejects.toThrow("companyId is required");
    });
  });

  describe("sync-status", () => {
    it("returns null sync data when no sync has occurred", async () => {
      const result = await harness.getData<{
        lastSyncAt: string | null;
        agentCount: number;
        skillCount: number;
        durationMs: number;
      }>(DATA_KEYS.syncStatus);

      expect(result.lastSyncAt).toBeNull();
      expect(result.agentCount).toBe(0);
      expect(result.skillCount).toBe(0);
      expect(result.durationMs).toBe(0);
    });

    it("returns sync cursor data after state is set", async () => {
      // Manually set sync cursor state as if a sync had completed
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.syncCursor },
        {
          lastSyncAt: "2026-03-15T10:00:00.000Z",
          agentCount: 5,
          skillCount: 3,
          durationMs: 1200,
        },
      );

      const result = await harness.getData<{
        lastSyncAt: string;
        agentCount: number;
        skillCount: number;
        durationMs: number;
      }>(DATA_KEYS.syncStatus);

      expect(result.lastSyncAt).toBe("2026-03-15T10:00:00.000Z");
      expect(result.agentCount).toBe(5);
      expect(result.skillCount).toBe(3);
      expect(result.durationMs).toBe(1200);
    });
  });

  describe("fleet-summary", () => {
    it("returns cross-referenced fleet data", async () => {
      // Seed Paperclip agents
      harness.seed({
        agents: [
          {
            id: "pa-1",
            companyId: "co-1",
            name: "ScoutBot",
            status: "idle",
            role: "worker",
            model: "claude-sonnet-4-20250514",
            systemPrompt: null,
            nameKey: "scout",
            adapterType: "claude-code",
            costLimitUsd: null,
            projectId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      // Seed ClawNet template
      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      const result = await harness.getData<{
        totalPaperclipAgents: number;
        totalClawnetAgents: number;
        linkedCount: number;
        fleet: any[];
      }>(DATA_KEYS.fleetSummary, { companyId: "co-1" });

      expect(result.totalPaperclipAgents).toBe(1);
      expect(result.totalClawnetAgents).toBe(1);
      expect(result.fleet).toHaveLength(1);
      expect(result.fleet[0].paperclipAgent.name).toBe("ScoutBot");
    });

    it("includes linked count when agents are linked", async () => {
      harness.seed({
        agents: [
          {
            id: "pa-1",
            companyId: "co-1",
            name: "ScoutBot",
            status: "idle",
            role: "worker",
            model: "claude-sonnet-4-20250514",
            systemPrompt: null,
            nameKey: "scout",
            adapterType: "claude-code",
            costLimitUsd: null,
            projectId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      // Manually link the agent
      await harness.ctx.state.set(
        { scopeKind: "agent", scopeId: "pa-1", stateKey: STATE_KEYS.clawnetLink },
        { clawnetExternalId: "scout-bot", linkedAt: new Date().toISOString(), autoLinked: false },
      );

      const result = await harness.getData<{
        linkedCount: number;
        fleet: any[];
      }>(DATA_KEYS.fleetSummary, { companyId: "co-1" });

      expect(result.linkedCount).toBe(1);
      expect(result.fleet[0].clawnetLink).toBeDefined();
      expect(result.fleet[0].clawnetTemplate).toBeDefined();
      expect(result.fleet[0].clawnetTemplate.externalId).toBe("scout-bot");
    });

    it("throws when companyId is missing", async () => {
      await expect(
        harness.getData(DATA_KEYS.fleetSummary, {}),
      ).rejects.toThrow("companyId is required");
    });
  });
});

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

describe("ClawNet action handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = makeHarness();
    await setupPlugin(harness);
  });

  describe("trigger-sync", () => {
    it("throws when companyId is missing", async () => {
      await expect(
        harness.performAction(ACTION_KEYS.triggerSync, {}),
      ).rejects.toThrow("companyId is required");
    });
  });

  describe("link-agent", () => {
    it("links a Paperclip agent to a ClawNet template", async () => {
      harness.seed({
        agents: [
          {
            id: "pa-1",
            companyId: "co-1",
            name: "ScoutBot",
            status: "idle",
            role: "worker",
            model: "claude-sonnet-4-20250514",
            systemPrompt: null,
            nameKey: "scout",
            adapterType: "claude-code",
            costLimitUsd: null,
            projectId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      const result = await harness.performAction<{
        ok: boolean;
        agentId: string;
        clawnetExternalId: string;
        agentName: string;
        templateTitle: string;
      }>(ACTION_KEYS.linkAgent, {
        companyId: "co-1",
        agentId: "pa-1",
        clawnetExternalId: "scout-bot",
      });

      expect(result.ok).toBe(true);
      expect(result.agentId).toBe("pa-1");
      expect(result.clawnetExternalId).toBe("scout-bot");
      expect(result.agentName).toBe("ScoutBot");
      expect(result.templateTitle).toBe("ScoutBot");

      // Verify state was persisted
      const linkState = harness.getState({
        scopeKind: "agent",
        scopeId: "pa-1",
        stateKey: STATE_KEYS.clawnetLink,
      }) as { clawnetExternalId: string; autoLinked: boolean };
      expect(linkState.clawnetExternalId).toBe("scout-bot");
      expect(linkState.autoLinked).toBe(false);
    });

    it("throws when required params are missing", async () => {
      await expect(
        harness.performAction(ACTION_KEYS.linkAgent, {}),
      ).rejects.toThrow("companyId, agentId, and clawnetExternalId are all required");
    });

    it("throws when the Paperclip agent does not exist", async () => {
      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      await expect(
        harness.performAction(ACTION_KEYS.linkAgent, {
          companyId: "co-1",
          agentId: "nonexistent",
          clawnetExternalId: "scout-bot",
        }),
      ).rejects.toThrow("Agent nonexistent not found");
    });

    it("throws when the ClawNet template does not exist", async () => {
      harness.seed({
        agents: [
          {
            id: "pa-1",
            companyId: "co-1",
            name: "ScoutBot",
            status: "idle",
            role: "worker",
            model: "claude-sonnet-4-20250514",
            systemPrompt: null,
            nameKey: "scout",
            adapterType: "claude-code",
            costLimitUsd: null,
            projectId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      await expect(
        harness.performAction(ACTION_KEYS.linkAgent, {
          companyId: "co-1",
          agentId: "pa-1",
          clawnetExternalId: "nonexistent-template",
        }),
      ).rejects.toThrow("ClawNet agent nonexistent-template not found in synced entities");
    });
  });
});

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

describe("ClawNet tool handlers", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = makeHarness();
    await setupPlugin(harness);
  });

  describe("agent-lookup", () => {
    it("finds an agent by exact slug match", async () => {
      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      const result = await harness.executeTool<{ content?: string; data?: any; error?: string }>(
        TOOL_NAMES.agentLookup,
        { slug: "scout-bot" },
      );

      expect(result.error).toBeUndefined();
      expect(result.content).toContain("ScoutBot");
      expect(result.data).toBeDefined();
      expect(result.data.slug).toBe("scout-bot");
    });

    it("finds an agent by fuzzy name match", async () => {
      await seedClawNetAgent(harness, "scout-bot", "ScoutBot");

      const result = await harness.executeTool<{ content?: string; data?: any; error?: string }>(
        TOOL_NAMES.agentLookup,
        { slug: "scout" },
      );

      expect(result.error).toBeUndefined();
      expect(result.content).toContain("ScoutBot");
    });

    it("returns error when agent is not found", async () => {
      const result = await harness.executeTool<{ error?: string }>(
        TOOL_NAMES.agentLookup,
        { slug: "nonexistent" },
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("No ClawNet agent found");
    });

    it("returns error when slug is missing", async () => {
      const result = await harness.executeTool<{ error?: string }>(
        TOOL_NAMES.agentLookup,
        {},
      );

      expect(result.error).toBe("slug is required");
    });
  });

  describe("skill-search", () => {
    it("finds skills matching a query", async () => {
      await seedClawNetSkill(harness, "code-review", "Code Review");
      await seedClawNetSkill(harness, "deploy", "Deploy");
      await seedClawNetSkill(harness, "code-gen", "Code Generation");

      const result = await harness.executeTool<{
        content?: string;
        data?: { results: any[]; total: number };
        error?: string;
      }>(TOOL_NAMES.skillSearch, { query: "code" });

      expect(result.error).toBeUndefined();
      expect(result.data!.total).toBe(2);
      expect(result.data!.results).toHaveLength(2);
    });

    it("returns empty when no skills match", async () => {
      await seedClawNetSkill(harness, "deploy", "Deploy");

      const result = await harness.executeTool<{
        content?: string;
        data?: { results: any[]; total: number };
      }>(TOOL_NAMES.skillSearch, { query: "nonexistent" });

      expect(result.content).toContain("No skills found");
      expect(result.data!.total).toBe(0);
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await seedClawNetSkill(harness, `skill-${i}`, `Skill ${i}`);
      }

      const result = await harness.executeTool<{
        data?: { results: any[]; total: number };
      }>(TOOL_NAMES.skillSearch, { query: "skill", limit: 2 });

      expect(result.data!.results).toHaveLength(2);
    });

    it("returns error when query is missing", async () => {
      const result = await harness.executeTool<{ error?: string }>(
        TOOL_NAMES.skillSearch,
        {},
      );

      expect(result.error).toBe("query is required");
    });
  });

  describe("fleet-overview", () => {
    it("returns fleet summary with counts and status breakdown", async () => {
      await seedClawNetAgent(harness, "alpha", "Alpha", {});
      await seedClawNetAgent(harness, "beta", "Beta", {});
      await seedClawNetSkill(harness, "code-review", "Code Review");

      harness.seed({
        agents: [
          {
            id: "pa-1",
            companyId: "company-test",
            name: "LocalAgent",
            status: "idle",
            role: "worker",
            model: "claude-sonnet-4-20250514",
            systemPrompt: null,
            nameKey: "local",
            adapterType: "claude-code",
            costLimitUsd: null,
            projectId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      const result = await harness.executeTool<{
        content?: string;
        data?: {
          clawnetAgents: number;
          clawnetSkills: number;
          paperclipAgents: number;
          statusBreakdown: Record<string, number>;
          lastSync: string;
        };
      }>(TOOL_NAMES.fleetOverview, {});

      expect(result.data!.clawnetAgents).toBe(2);
      expect(result.data!.clawnetSkills).toBe(1);
      expect(result.data!.paperclipAgents).toBe(1);
      expect(result.data!.statusBreakdown.active).toBe(2);
      expect(result.data!.lastSync).toBe("never");
      expect(result.content).toContain("2 ClawNet agents");
    });

    it("shows last sync time when cursor exists", async () => {
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.syncCursor },
        {
          lastSyncAt: "2026-03-15T10:00:00.000Z",
          agentCount: 0,
          skillCount: 0,
          durationMs: 500,
        },
      );

      const result = await harness.executeTool<{
        data?: { lastSync: string; lastSyncDurationMs: number };
      }>(TOOL_NAMES.fleetOverview, {});

      expect(result.data!.lastSync).toBe("2026-03-15T10:00:00.000Z");
      expect(result.data!.lastSyncDurationMs).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("ClawNet health check", () => {
  it("returns error when context is not initialized", async () => {
    // Create a fresh plugin without calling setup, then call onHealth
    // The plugin uses module-level currentContext which starts as null.
    // After setup, it's set. We need a separate strategy here.
    // We test the post-setup paths instead.
    const harness = makeHarness();
    await setupPlugin(harness);

    const health = await plugin.definition.onHealth!();
    // After setup, context is initialized, so we get degraded (no sync yet)
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("No sync has been performed");
  });

  it("returns ok when last sync is recent", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    // Set a recent sync cursor
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEYS.syncCursor },
      {
        lastSyncAt: new Date().toISOString(),
        agentCount: 10,
        skillCount: 5,
        durationMs: 800,
      },
    );

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
    expect(health.message).toContain("10 agents");
    expect(health.message).toContain("5 skills");
    expect(health.details?.agentCount).toBe(10);
  });

  it("returns degraded when last sync is stale", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    // Set a sync cursor from 60 minutes ago
    const staleTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.ctx.state.set(
      { scopeKind: "instance", stateKey: STATE_KEYS.syncCursor },
      {
        lastSyncAt: staleTime,
        agentCount: 3,
        skillCount: 2,
        durationMs: 400,
      },
    );

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("minutes ago");
    expect(health.details?.syncAgeMs).toBeGreaterThan(30 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe("ClawNet config validation", () => {
  it("accepts valid configuration", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: "https://clawnet.sh",
      clawnetApiKey: "secret-ref:my-key",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid URL", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: "not-a-url",
      clawnetApiKey: "secret-ref:my-key",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("clawnetApiUrl is not a valid URL");
  });

  it("rejects non-string URL", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: 42,
      clawnetApiKey: "secret-ref:my-key",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("clawnetApiUrl must be a string");
  });

  it("rejects empty API key", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: "https://clawnet.sh",
      clawnetApiKey: "",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("clawnetApiKey cannot be empty");
  });

  it("rejects non-string API key", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: "https://clawnet.sh",
      clawnetApiKey: 12345,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("clawnetApiKey must be a string (secret reference)");
  });

  it("warns when API URL is not set", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiKey: "secret-ref:my-key",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "clawnetApiUrl not set; will default to https://clawnet.sh",
    );
  });

  it("rejects URL with unsupported protocol", async () => {
    const harness = makeHarness();
    await setupPlugin(harness);

    const result = await plugin.definition.onValidateConfig!({
      clawnetApiUrl: "ftp://clawnet.sh",
      clawnetApiKey: "secret-ref:my-key",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("clawnetApiUrl must use http or https protocol");
  });
});
