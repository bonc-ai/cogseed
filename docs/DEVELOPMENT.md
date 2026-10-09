# CogSeed Development Guide

> **受众**：开发者 / 贡献者。用户入门请看 [README](../README.md)。
> **本文档**：CogSeed 的架构、开发、测试与维护细节。

## Table of Contents

- [Architecture](#architecture)
- [Execution Boundaries](#execution-boundaries)
- [Skills, Connectors, and Library](#skills-connectors-and-library)
- [Cognition and Recall](#cognition-and-recall)
- [Data and Security](#data-and-security)
- [Runtime and Dependencies](#runtime-and-dependencies)
- [Repository Layout](#repository-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│ Renderer: classic HTML / CSS / JavaScript               │
│ Tasks · Spaces · Automation · Assets · Connections      │
└───────────────────────────┬─────────────────────────────┘
                            │ window.cogseed.invoke / stream
┌───────────────────────────▼─────────────────────────────┐
│ Preload: contextBridge allow-list                       │
└───────────────────────────┬─────────────────────────────┘
                            │ Electron IPC
┌───────────────────────────▼─────────────────────────────┐
│ Main process: IPC validation → feature workflows        │
│ Group Chat · Recall · Knowledge Base · Connectors       │
└──────────────┬────────────────┬────────────────┬────────┘
               │                │                │
               ▼                ▼                ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Core Agent       │  │ Runtime worker   │  │ Child processes  │
│ In-process       │  │ JSONL protocol   │  │ Local CLI / MCP  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Execution Boundaries

| Boundary | Responsibility |
|---|---|
| Renderer | Classic scripts render the desktop UI and call only the exposed `window.cogseed` API. |
| Preload | Maintains the explicit contextBridge allow-list and maps invoke or stream requests to Electron IPC. |
| IPC handlers | Validate request arguments and delegate to feature modules; business logic stays out of handlers. |
| Feature layer | Owns conversations, workspaces, agents, skills, Recall, connectors, messaging, and other workflows. |
| Core Agent | Runs model sessions and tool orchestration in-process through the dynamically loaded `#core-agent`. |
| CogSeed Runtime | Runs isolated backend work through a dedicated worker process and JSONL protocol. |
| Local Agent runner | Owns the approved child-process path for supported CLI agents. |
| MCP client | Owns stdio connector processes and exposes connected actions through connector meta-tools. |
| Storage and paths | Centralize user data paths, path sandboxing, JSON/JSONL storage, and the KB vector database. |

## Skills, Connectors, and Library

### Skills and Agents

- Custom agents and skills live in user-scoped cloud state.
- Platform agents and skills are installed marketplace content stored in the machine-local tier.
- Custom skills may override a same-name platform skill; platform duplicates remain addressable by internal ID.
- Skill execution goes through `bin/run-skill.cjs` and the installed skill tier.
- Quality, trust, and path checks run before sensitive skill operations are admitted.

### Connectors

- Hosted connector authorization starts through the configured account service and returns through the application protocol callback (`cogseed://` deep link).
- Token-bearing grant and transport state is encrypted before local persistence.
- The model receives only currently connected, enabled, and session-eligible connectors.
- Connector actions are discovered with `list_connector_tools` and invoked with `call_connector_tool`.

### Library and Knowledge Base

- Source files are user-managed and may be sync-eligible.
- Derived chunks, embeddings, model configuration, and the vector database remain machine-local.
- Agents search and read Library content through dedicated KB tools.
- PDF and DOCX access follows file-stat and bounded read paths rather than eager attachment extraction.

## Cognition and Recall

CogSeed treats reusable experience as governed state rather than automatically promoting every conversation summary.

| Stage | Meaning |
|---|---|
| Candidate | A captured lesson or reusable pattern waiting for review. |
| Confirmed asset | A user-approved capability asset with stable identity, version, scope, and provenance. |
| Projection | A prepared asset reference made available to a later task. |
| Transfer evidence | Evidence that the projected asset entered the target execution. |
| Effectiveness evidence | Feedback or outcome information used to assess whether the reuse helped. |

Assets can be paused, resumed, revised, or rolled back through the established Cognition workflows. Personal Ontology organizes confirmed concepts and relationships without granting agents unrestricted access to private data directories.

## Data and Security

### User Data Domains

```text
<container>/data/<uid>/
├── cloud/
│   ├── conversations, sessions, attachments, and artifacts
│   ├── projects, automations, contexts, memory, agents, and skills
│   └── saved apps, marketplace manifests, and user configuration
└── local/
    ├── account and session cache
    ├── marketplace installations and local-agent archives
    ├── indexes, vector database, model caches, and tool-result spills
    └── workspace selection and other machine-private state
```

The `cloud` and `local` names describe synchronization eligibility, not public visibility. Cloud state remains user-private and is synchronized only when the configured hosted account and entitlement support it. Model credentials remain behind the local secret-storage facade.

### Security Controls

| Control | Enforcement |
|---|---|
| Renderer isolation | Context isolation and the preload allow-list prevent direct Node.js access. |
| No local web backend | The main process does not expose an HTTP server or local authentication surface. |
| Path sandbox | File-class tools validate workspace and attachment paths at entry. |
| Process choke points | Runtime workers, local CLI agents, and MCP stdio connectors spawn only through approved modules. |
| Artifact isolation | `chat-app://` serves validated artifact files to sandboxed iframes without exposing IPC. |
| Secret handling | Hosted secrets and token-bearing connector state stay behind encrypted local storage facades. |
| Tool result limits | Large results pass through centralized caps and spill handling. |
| User confirmation | Sensitive operations use explicit permission and confirmation flows instead of silent escalation. |

## Runtime and Dependencies

| Component | Repository baseline | Purpose |
|---|---|---|
| Electron | `^41.7.1` | Desktop shell and main/renderer process boundary |
| TypeScript | `^6.0.3` | Main-process, feature, model, and test code |
| Node.js runtime bundle | `24.17.0` | Node-based skills and packaged command execution |
| Python runtime bundle | `3.12.13` | Python skills, package tooling, and resource tests |
| uv | `0.11.21` | Python environment and package management |
| SQLite and sqlite-vec | Repository dependencies | Local structured storage and KB vector search |
| OfficeCLI | Prepared platform resource | Enabled document and office workflows |

Pinned runtime downloads are described and checksummed in `resources/runtime/manifest.json`.

## Repository Layout

| Path | Purpose |
|---|---|
| `bootstrap.cjs` | Electron entry shim, runtime identity selection, and TypeScript loader registration |
| `src/main/` | Main process, IPC, storage, model adapters, utilities, and feature workflows |
| `src/renderer/` | Classic HTML, CSS, JavaScript, localization, and desktop UI |
| `src/core-agent/` | Core Agent sessions, providers, tool orchestration, and execution loop |
| `src/main/features/group_chat/` | Conversation bus, plan execution, worker scheduling, and abort handling |
| `src/main/features/local_agents/` | Supported CLI detection, adapters, sessions, and centralized runner |
| `src/main/features/recall/` | Candidate capture, formal assets, projections, proofs, and effectiveness feedback |
| `src/main/features/connectors/` | Connector metadata, authorization state, MCP clients, and tool exposure |
| `resources/builtin/` | Platform agents, skills, and marketplace seed content |
| `resources/runtime/` | Pinned runtime manifests and platform assets |
| `p3394-gateway/` | Local Bridge gateway, protocol integration, and publication guidance |
| `test/` | Main-process, renderer, resource, native, and cross-layer tests |
| `scripts/` | Dependency preparation, diagnostics, packaging, audits, and verification tools |

## Development

### Common Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | Run TypeScript checking without emitting files |
| `npm test` | Run JavaScript and resource test suites with native ABI management |
| `npm run test:coverage` | Run the JavaScript suite with coverage |
| `npm run test:platform-native` | Run platform-native verification |
| `npm run runtime:ensure` | Verify or prepare the pinned runtime bundle |
| `npm run builtin:manifest:check` | Verify the built-in marketplace manifest |
| `npm run audit:workspace` | Audit the local workspace layout and invariants |
| `npm run diagnose:agents` | Diagnose supported local Agent installations |
| `npm run rebuild:sqlite:electron` | Repair the Electron SQLite native ABI |
| `npm run rebuild:pty:electron` | Repair the Electron node-pty native ABI |
| `scripts/restart-cogseed.sh` | Restart only this worktree's CogSeed runtime |

Use `npm test` rather than invoking Vitest directly. The repository test runner manages Electron and Node native SQLite ABI switching and recovery.

### Development Rules

- Keep IPC handlers focused on validation and feature delegation.
- Keep renderer code as classic scripts and register new files in `src/renderer/index.html`.
- Dynamically import `#core-agent`; static imports can break startup ordering and ESM resolution.
- Route user-private data through the active user ID and the canonical storage helpers.
- Register boot-time asynchronous work through `util/boot_init.ts`.
- Add new Core Agent tools to the central catalog and runner wiring.
- Run `npm run typecheck` after merges that touch renderer-to-main IPC contracts.

## Troubleshooting

### Native SQLite errors

```bash
npm run rebuild:sqlite:electron
```

### Terminal or node-pty ABI errors

```bash
npm run rebuild:pty:electron
```

### Missing bundled runtime resources

```bash
npm run runtime:ensure
```

### Local Agent is not detected

```bash
npm run diagnose:agents
```

Confirm that the corresponding CLI is installed and available to the shell used to launch CogSeed.

### Windows and WSL

Use `run.cmd` for the Windows-native runtime. The shell launcher delegates to it when WSL and the required Windows bridge commands are available.

### Model connection problems

Open **Connections → Models & Quota**, test the authorization again, and select a model returned by the configured provider. Do not place API keys in repository files or README examples.
