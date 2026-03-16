# Tortuga Plugin Architecture

Based on comprehensive analysis of the Paperclip Plugin SDK source code by 4 specialist agents (2026-03-15).

## Two-Plugin Architecture

### ClawNet Plugin (`@bopen-io/clawnet-plugin`)
The marketplace/registry bridge. Generic — any Paperclip operator can install it.

- Agent and skill sync from ClawNet registry (scheduled jobs)
- Agent marketplace UI (browse, search, trust scores, attestations)
- Skill browser UI
- Inbound webhook for ClawNet status events
- Agent tools: `clawnet:agent-status`, `clawnet:list-skills`, `clawnet:fleet-overview`
- Emits `plugin.clawnet.agent-sync-done` for other plugins

### Tortuga Plugin (`@bopen-io/tortuga-plugin`)
bOpen's operational layer. Specific to how bOpen runs its fleet.

- Fleet monitoring dashboard (heartbeat status, health, cost)
- Event subscriptions for real-time fleet tracking
- Fleet health check job (every 5 min)
- Agent session management (two-way chat)
- Fleet tools: `tortuga:find-capable-agent`, `tortuga:dispatch-to-agent`
- Listens to ClawNet plugin events

## Agent Creation: UI-Driven Marketplace Approach

The plugin SDK does not include `agents.create` — and we don't need it. The plugin's role is to be the **marketplace browser**, not an agent factory.

**Flow:**
1. Plugin syncs agents from ClawNet registry into plugin entities
2. Plugin UI shows the marketplace (browse, search, trust scores, attestations, skills, model info)
3. Operator clicks "Hire Agent" on a ClawNet agent
4. Plugin pre-fills Paperclip's existing agent creation UI with data from ClawNet (name, description, adapter config, system prompt)
5. Paperclip's own governance system handles the rest (approval if needed, creation, budget assignment)

The plugin surfaces the right information for informed decisions. Paperclip handles the agent lifecycle. No upstream changes needed.

**Upstream status (checked 2026-03-15):** No `agents.create` work in any upstream branch. The `paperclip-company-import-export` branch adds skills sync and company export/import but no plugin-level agent creation. The `events.subscribe` RPC is being refactored in that branch.

## Minimum Viable Capability Set (v1)

12 capabilities out of 37 available (32% surface):

```typescript
capabilities: [
  "agents.read",                    // fleet monitoring
  "plugin.state.read",             // sync cursors
  "plugin.state.write",            // persist sync state
  "events.subscribe",              // agent lifecycle events
  "jobs.schedule",                 // scheduled ClawNet sync
  "http.outbound",                 // call ClawNet API
  "secrets.read-ref",              // ClawNet API key
  "agent.tools.register",          // expose skills as tools
  "ui.dashboardWidget.register",   // fleet status widget
  "ui.page.register",              // fleet monitoring page
  "ui.sidebar.register",           // navigation entry
  "instance.settings.register",    // ClawNet config page
]
```

### Capabilities Excluded from v1 (and why)
- `agents.pause/resume/invoke` — fleet control is v2, read-only monitoring first
- `agent.sessions.*` — interactive chat is v2
- `events.emit` — no custom events to emit yet
- `webhooks.receive` — v1 uses pull (jobs), v2 adds push
- `metrics.write`, `activity.log.write` — v2 analytics
- `ui.detailTab.register`, `ui.action.register` — v2 UI features

## Worker Runtime Model

The worker is a **long-lived child process** communicating via JSON-RPC 2.0 over stdin/stdout.

- Runs in a `vm.createContext()` sandbox — no `process`, `require`, `fs`, `net`
- All host interactions go through capability-gated `PluginContext` methods
- Outbound HTTP proxied through host (`ctx.http.fetch`)
- Secrets resolved through host provider (`ctx.secrets.resolve`)
- Module evaluation timeout: 2 seconds
- Crash recovery: exponential backoff (1s → 5min cap), max 10 crashes per 10min window

## UI Extension Points Available

13 slot types. v1 uses 4:

| Slot | Capability | v1 Use |
|------|-----------|--------|
| `dashboardWidget` | `ui.dashboardWidget.register` | Fleet status summary |
| `page` | `ui.page.register` | Full fleet monitoring page (route: `tortuga`) |
| `sidebar` | `ui.sidebar.register` | Navigation entry to fleet page |
| `settingsPage` | `instance.settings.register` | ClawNet API key config |

### v2 UI opportunities:
- `globalToolbarButton` — always-visible "N agents online" badge
- `detailTab` on agents — runs history, skills tab per agent
- `contextMenuItem` on agents — "redeploy", "view heartbeats"
- `sidebarPanel` — persistent fleet strip
- Launcher modals — "Deploy Agent" flow from anywhere

## UI Hooks

| Hook | Returns | Worker Side |
|------|---------|-------------|
| `usePluginData<T>(key, params?)` | `{ data, loading, error, refresh }` | `ctx.data.register(key, handler)` |
| `usePluginAction(key)` | `async (params?) => result` | `ctx.actions.register(key, handler)` |
| `useHostContext()` | `{ companyId, entityId, entityType, ... }` | N/A (host-injected) |
| `usePluginStream<T>(channel, opts?)` | `{ events, lastEvent, connected }` | `ctx.streams.emit(channel, event)` |
| `usePluginToast()` | `(input) => id` | N/A (host-managed) |

## Scheduled Jobs

| Job | Cron | Purpose |
|-----|------|---------|
| `clawnet-sync` | `*/15 * * * *` | Sync agents/skills from ClawNet → plugin entities |
| `fleet-health` | `*/5 * * * *` | Cross-reference Paperclip agents with fleet state |

## Event Subscriptions

| Event | Purpose |
|-------|---------|
| `agent.status_changed` | Real-time fleet health → `ctx.streams.emit("fleet-status", ...)` |
| `agent.run.finished` | Track fleet activity, update metrics |
| `agent.run.failed` | Alert on failures |
| `agent.created` | Detect new agents, offer ClawNet linking |
| `cost_event.created` | Accumulate per-agent cost (v2) |

## Agent Tools to Register

| Tool | Description |
|------|-------------|
| `clawnet:agent-status` | Check ClawNet bot health by slug |
| `clawnet:list-skills` | Search available skills from registry |
| `clawnet:fleet-overview` | Summary of all ClawNet bots |
| `tortuga:find-capable-agent` | Match a task description to the best fleet agent |
| `tortuga:dispatch-to-agent` | Hand off a subtask to a named fleet agent |

## Streaming Channels

| Channel | Source | Purpose |
|---------|--------|---------|
| `fleet-status` | Event handlers + webhook | Live agent status to UI |
| `sync-progress` | Sync job | Progress indicator during sync |
| `fleet-alert` | Run failure handler | High-priority alerts |

## Secrets Configuration

`instanceConfigSchema` should declare:
- `clawnetApiUrl` — string, ClawNet registry URL
- `clawnetApiKey` — string with `format: "secret-ref"`, resolved via `ctx.secrets.resolve()`

## Implementation Order

1. **Entity mirror + scheduled sync** — foundation for everything
2. **Event subscriptions** — real-time fleet tracking
3. **Fleet dashboard UI** — widget + page + sidebar + streaming
4. **Settings page** — ClawNet API key configuration
5. **Agent tools** — expose skills to Paperclip agents
6. **Inbound webhook** (v2) — real-time ClawNet push
7. **Fleet control** (v2) — pause/resume/invoke from UI
8. **Agent sessions** (v2) — two-way chat
9. **Marketplace with trust-gated hiring** (v2) — needs `agents.create` upstream

## Key References

- Plugin SDK types: `~/code/paperclip/packages/plugins/sdk/src/types.ts`
- Plugin SDK define-plugin: `~/code/paperclip/packages/plugins/sdk/src/define-plugin.ts`
- Capability validator: `~/code/paperclip/server/src/services/plugin-capability-validator.ts`
- Manifest validator: `~/code/paperclip/packages/shared/src/validators/plugin.ts`
- Runtime sandbox: `~/code/paperclip/server/src/services/plugin-runtime-sandbox.ts`
- Kitchen sink example: `~/code/paperclip/packages/plugins/examples/plugin-kitchen-sink-example/`
- Plugin spec: `~/code/paperclip/doc/plugins/PLUGIN_SPEC.md`
- Our skill: `~/code/prompts/skills/paperclip-plugin-dev/SKILL.md`
