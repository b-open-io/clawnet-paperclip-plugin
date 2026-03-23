# Changelog

## 0.0.11

### Added
- Skill distribution: automatically assign ClawNet template skills when a hired agent becomes active
- Routine awareness: surface routine-execution issues per agent in marketplace UI
- `agent-routines` data handler for routine activity data
- `issues.read` capability for execution issue queries

### Changed
- Hire prompt now references ClawNet registry API for full agent definition (systemPrompt, skills, tools)
- Hire instructions include steps to set agent instructions via Paperclip API
- `agent.status_changed` handler triggers skill distribution when agent goes idle
- `agent.created` handler triggers skill distribution after auto-linking
- Fleet summary includes `skillsDistributed` status per agent

## 0.0.10

### Added
- Agent icon display in marketplace cards and detail view (falls back to color dot)
- Hire Agent copies a CEO-ready prompt to clipboard for agent creation

### Changed
- Removed API key requirement from settings (not needed for public read-only sync)
- API key validation downgraded from error to warning

## 0.0.4

### Fixed

- Transform entity data to match UI types (agents, skills, fleet summary now return correctly shaped objects)

## 0.0.3

### Fixed

- Register validate-config action handler (was called by settings UI but never registered)
- Consolidate default API URL to single source via DEFAULT_CONFIG
- Add SSRF hostname validation blocking private/internal addresses
- Namespace stream channels to clawnet:* prefix (prevents collision with Tortuga plugin)
- Add cursor-based pagination loop in sync (was single-page fetch)
- Remove duplicate JOB_KEYS/ENTITY_TYPES constant aliases
- Build constants.js separately for bundle:false manifest

### Added

- 43 tests covering all handlers, events, tools, lifecycle
- Full ClawNet API client with typed responses
- Marketplace UI (dashboard widget, page, sidebar, settings)
- Worker with sync job, event handlers, data/action handlers, agent tools

## 0.0.2

### Fixed

- Build constants.js separately so manifest can import it at runtime

## 0.0.1

### Added

- Initial scaffold
