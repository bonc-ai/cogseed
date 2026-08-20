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

CogSeed brings tasks, workspaces, AI teams, skills, connectors, personal knowledge, and reusable cognitive assets into one Electron desktop application. It is designed for work that needs more than a single chat turn: planning, delegation, tool use, local project access, continuity across sessions, reviewable evidence, and long-term reuse.

A Commander maintains the shared plan and delegates work through structured dispatch. Built-in agents and supported local CLI agents operate through controlled execution paths, while each worker receives only the context needed for its role. Results can remain as conversation output, become workspace files or artifacts, or enter the Cognition and Recall workflow as user-reviewed capability assets.

CogSeed is local-first. The renderer cannot access Node.js directly, local tools run behind explicit gateways, and user-scoped data is separated into sync-eligible private state and machine-local state.

## Highlights

| Capability | What it enables |
|---|---|
| Structured multi-agent coordination | Plan, delegate, observe, retry, skip, and stop work through one group-chat execution path. |
| Local CLI agent integration | Use Claude Code, Codex, OpenClaw, OpenCode, Hermes, or WorkBuddy from the same workspace. |
| Continuity across tasks | Import supported sessions and continue work with workspace context, progress, constraints, and execution evidence. |
| Governed cognitive assets | Review candidate experience, promote confirmed assets, version them, and track reuse and effectiveness evidence. |
| Connected tools and knowledge | Give supported agents controlled access to skills, MCP connectors, messaging touchpoints, and indexed Library content. |
| Local-first security boundaries | Keep credentials, indexes, caches, tool results, and local installations behind explicit storage and execution boundaries. |

## Core Workflows

### Tasks and Spaces

- Start a focused task or organize related work inside a Space.
- Select agents, skills, connectors, and Library files from the task composer with `@`.
- Associate conversations with a workspace directory without encoding project identity into file paths or session IDs.
- Review plans, member status, process events, produced files, artifacts, and conversation history in one place.

### Commander and AI Team

- The Commander translates the user goal into a shared plan.
- Structured `dispatch_to` actions assign work to specific members.
- `plan_set` owns plan state, including retries, skips, and reconciliation.
- Every worker reads its visibility slice instead of the full conversation record.
- Group abort is the single stop path for all active actors.

### Continue Existing Work

- Import supported histories from local coding-agent environments.
- Carry forward the working directory, current progress, known constraints, and available evidence.
- Keep imported source sessions separate from CogSeed conversation and execution state.
- Resume through normal task dispatch rather than bypassing the collaboration pipeline.

### Skills, Connections, and Library

- Install or create agents and skills, then control which skills an agent may use.
- Connect supported external services through OAuth or MCP transports.
- Expose connector actions through list-and-call meta-tools instead of injecting every remote action into the model context.
- Store user-managed source material in the Library while keeping derived indexes and vector data machine-local.

### Cognition and Recall

- Capture candidate experience from sessions, review signals, and teaching interactions.
- Require user confirmation before a candidate becomes a formal capability asset.
- Preserve stable IDs, versions, scope policy, provenance, and audit history.
- Record transfer and effectiveness evidence when an asset is reused in later work.

### Automation, Touchpoints, and Artifacts

- Run saved automation tasks through the same guarded execution surface.
- Connect supported messaging touchpoints, including Feishu and WeChat integrations where configured.
- Produce chat artifacts inside conversation-scoped storage and display them through the validated artifact resolver.
- Save reusable apps separately; editing a saved app creates a forked conversation rather than mutating it in place.



## Quick Install

### Requirements

- Git
- Node.js and npm available in the development shell
- Network access during first setup for npm packages and pinned runtime resources
- macOS or Windows for the primary desktop targets

Clone the repository and install its dependencies:

```bash
git clone https://github.com/bonc-ai/cogseed.git
cd cogseed
npm install
```

The repository pins `npm@11.11.0`. Installation prepares Electron native dependencies and the embedding model. Development startup also verifies or downloads the platform runtime and OfficeCLI resources required by enabled features.

## Quick Start

Start CogSeed on macOS or a Linux development environment:

```bash
./run.sh
```

On Windows:

```bat
run.cmd
```

The source launcher verifies dependencies, prepares the `cogseed` runtime variant, and starts Electron with an isolated data root and application identity.

### First-Run Setup

1. Open **Connections → Models & Quota**.
2. Add an API key, configure a supported OAuth authorization, or import a compatible authorization from CC Switch.
3. Test the connection and select one or more returned models.
4. Create a task and type `@` to select agents, skills, connectors, or Library files.
5. Choose a workspace when the task needs controlled access to local project files.

## Local Agent Support

The corresponding CLI must be installed or configured on the machine before CogSeed can use it.

| CLI | Primary role | CogSeed integration |
|---|---|---|
| Claude Code | End-to-end coding tasks | Managed process, workspace context, session resume, event mapping, and supported bridge injection |
| Codex | Coding, patches, debugging, and refactoring | Managed process, app-server support, workspace evidence, and supported bridge injection |
| OpenClaw | General orchestration and lightweight automation | Managed process with backend-specific progress and idle handling |
| OpenCode | Coding with selectable providers, including local models | Managed process, terminal activity, and supported session import |
| Hermes | Multi-step tasks and tool-driven workflows | Managed process, session-scoped resume, and supported bridge injection |
| WorkBuddy | End-to-end coding through CodeBuddy CLI | Managed process, workspace context, session resume, and file-change evidence |

Local CLI execution is centralized in `src/main/features/local_agents/runner.ts`. The runner manages backend selection, working directory, environment overlays, cancellation, event mapping, idle detection, and result evidence.

## Architecture and Data

CogSeed is a single-process Electron application with explicit boundaries between the desktop backend and the interface:

- `src/main/` contains the TypeScript backend, business workflows, storage, model adapters, and controlled tool execution.
- `src/renderer/` contains the vanilla HTML, CSS, and JavaScript interface. It has no direct Node.js access.
- `src/main/preload.js` exposes the allow-listed `window.cogseed` bridge. Renderer-to-main communication goes through the canonical IPC invoke and stream paths.
- Local CLI agents run as managed child processes through one runner; MCP stdio connectors and isolated runtime workers use their own dedicated process gateways.

User-scoped state is separated under the application data container. Sync-eligible private data lives under `data/<uid>/cloud/`, while indexes, caches, credentials, local installations, and other machine-specific state live under `data/<uid>/local/`. Development launchers use an isolated `.cogseed` data root so source builds do not share state with packaged applications.

The `cogseed://` protocol handles validated application deep links. Conversation artifacts and saved apps use separate resolvers and sandboxed display paths; artifact content cannot access `window.cogseed`. Attachments are stored without eager preprocessing. Images, audio, documents, and ordinary video attachments can be displayed in the conversation, while video attachments remain display-only and are not supplied as model input.

## Development

| Command | Purpose |
|---|---|
| `npm run typecheck` | Run the TypeScript compiler without emitting build output |
| `npm run lint` | Run static checks for source, tests, and scripts |
| `npm test` | Run the complete JavaScript and resource test suite |
| `npm run readme:check` | Verify local links and bundled assets referenced by both READMEs |
| `npm run builtin:manifest:check` | Verify that bundled marketplace resources match the generated manifest |
| `./run.sh` | Prepare dependencies and start the development application |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow and [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for runtime, packaging, and platform-specific details.

## Cognition and Recall

Cognition turns reviewed work experience into reusable capability assets instead of silently treating every conversation as permanent memory. Candidate experience can come from session capture, review signals, and explicit teaching. Promotion requires user confirmation and records provenance, version, scope, and audit history.

Recall retrieves approved assets for later tasks and records reuse evidence without merging unrelated user, conversation, or project scopes. Source files that are eligible for synchronization stay in the private cloud domain; derived indexes and vector data remain machine-local.

## Upstream Attribution

CogSeed is a secondary development of [Orkas](https://github.com/Orkas-AI/Orkas), extending its local-first multi-agent collaboration and tooling. The desktop `core-agent` component originates from [OpenClaw](https://github.com/openclaw/openclaw). CogSeed also incorporates planning and runtime adaptation patterns informed by [Hermes-Agent](https://github.com/NousResearch/hermes-agent).

Upstream copyright and license information is recorded in [`NOTICE`](./NOTICE). Third-party component notices are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Documentation

| Topic | Link |
|---|---|
| Engineering boundaries and repository rules | [AGENTS.md](./AGENTS.md) |
| Contributing guide | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Security policy and vulnerability reporting | [SECURITY.md](./SECURITY.md) |
| Source package contents and startup commands | [Source package notes](./README-源码包说明.txt) |
| P3394 bridge gateway *(advanced: cross-machine agent collaboration)* | [Gateway README](./p3394-gateway/README.md) |

## Standards

CogSeed implements the **IEEE P3394** standard for agent interoperability. Protocol
fields prefixed with `p3394` (for example `p3394-gateway`, `p3394_bridge`, and the
`P3394_*` environment variables) refer to that standard. CogSeed is a separate
open-source product; the IEEE P3394 standard remains the property of its
respective standards body.

## License

CogSeed is available under the [MIT License](./LICENSE).
