<p align="center">
  <img src="./assets/cogseed-icon.png" width="160" alt="CogSeed product icon">
</p>

<h1 align="center">CogSeed</h1>

<p align="center">A local-first desktop workspace for coordinating AI agents and turning task experience into reusable personal capability assets.</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/cogseed-homepage-hero-agent-continuity.png" width="1000" alt="CogSeed desktop workspace">
</p>

## Overview

CogSeed brings tasks, workspaces, agents, skills, connectors, knowledge, and reusable cognition assets into one Electron desktop application. A Commander maintains the shared plan and delegates work through structured dispatch, while each agent receives only the context needed for its role.

The application is local-first: the renderer reaches the Node.js main process through an explicit preload allow-list, local CLI agents run through controlled child-process adapters, and user data is separated into syncable and machine-local domains.

## Highlights

| Capability | What it enables |
|---|---|
| Structured multi-agent coordination | Plan, delegate, observe, retry, and stop work through one group-chat execution path. |
| Local CLI agent integration | Use Claude Code, Codex, OpenClaw, OpenCode, Hermes, or WorkBuddy from the same workspace. |
| Continuity across tasks | Import supported local sessions and continue work with workspace context and execution evidence. |
| Governed cognition assets | Review candidate experience, promote confirmed assets, and track reuse and effectiveness evidence. |
| Connected tools and knowledge | Give supported agents controlled access to skills, MCP connectors, and indexed Library content. |
| Local-first boundaries | Keep machine-private state, indexes, caches, and credentials behind explicit storage and security boundaries. |

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

## Quick Install

Clone the repository and install its dependencies:

```bash
git clone http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cog-seed
cd cog-seed
npm install
```

The repository pins `npm@11.11.0`. Installation and development startup prepare native Electron dependencies, the embedding model, and required platform resources. macOS and Windows are the primary desktop targets.

## Quick Start

Start CogSeed on macOS or a Linux development environment:

```bash
./run.sh
```

On Windows:

```bat
run.cmd
```

After the desktop workspace opens:

1. Open **Connections → Models & Quota**.
2. Add an API key or import a supported authorization from CC Switch.
3. Test the connection and select an available model.
4. Create a task and type `@` to select agents, skills, connectors, or Library files.

## Local Agent Support

CogSeed includes managed adapters for:

- Claude Code
- Codex
- OpenClaw
- OpenCode
- Hermes
- WorkBuddy

Each CLI remains a separate local tool. CogSeed manages dispatch, working-directory context, session continuity, process events, cancellation, and file-change evidence through the centralized local-agent runner.

## Cognition and Recall

Task experience can move through a reviewable cognition workflow:

- Session and review signals produce candidate experience.
- Candidates remain pending until the user confirms or rejects them.
- Confirmed assets keep stable identity, version, scope, and audit information.
- Reuse records and effectiveness evidence show whether an asset was carried into later work.
- Personal ontology and related workspace references organize confirmed knowledge.

## Tools, Knowledge, and Connections

- Skills are available through the installed skill catalog and dedicated runtime runner.
- MCP connectors expose connected services through list-and-call meta-tools rather than a flat tool list.
- The Library stores user-managed context sources; derived indexes and vector data remain machine-local.
- Agents access Library content through knowledge-base tools instead of scanning the context directory directly.
- Model authorization supports API keys, supported OAuth flows, custom endpoints, and CC Switch import where configured.

## Data and Security Boundaries

User-scoped data is stored under:

```text
<container>/data/<uid>/
├── cloud/   syncable user-private state
└── local/   machine-private state, caches, indexes, and installations
```

Key boundaries:

- The renderer has no direct Node.js access.
- Application communication uses the `window.cogseed` preload API and Electron IPC.
- The main process does not expose a local HTTP server.
- File tools enforce workspace and attachment path boundaries.
- Runtime shell and skill execution pass through dedicated tool gateways.
- Token-bearing connector and account data stays behind local secret-storage facades.

## Repository Layout

| Path | Purpose |
|---|---|
| `src/main/` | Electron main process, IPC, storage, models, and feature workflows |
| `src/renderer/` | Classic HTML, CSS, JavaScript, localization, and desktop UI |
| `src/core-agent/` | Core Agent execution, providers, sessions, and tools |
| `resources/builtin/` | Platform agents, skills, and marketplace seed content |
| `resources/runtime/` | Verified bundled runtime manifests and platform assets |
| `test/` | Main-process, renderer, resource, and cross-layer tests |
| `docs/` | Architecture, implementation, handoff, and integration documentation |

## Development

Run the TypeScript check:

```bash
npm run typecheck
```

Run the complete test suite:

```bash
npm test
```

Use `npm test` rather than invoking Vitest directly because the repository test runner manages native SQLite ABI preparation and recovery.

Restart the development application after changes:

```bash
scripts/restart-cogseed.sh
```

## Documentation

| Topic | Link |
|---|---|
| Engineering boundaries and contribution rules | [AGENTS.md](./AGENTS.md) |
| Runtime variant isolation | [Runtime variants](./docs/runtime-variants.md) |
| External messaging touchpoints | [Touchpoint v2 quick start](./docs/touchpoint-v2-quickstart.md) |
| P3394 implementation evidence | [P3394 conformance matrix](./docs/P3394-Conformance-Matrix.md) |

## License

CogSeed is available under the [MIT License](./LICENSE).
