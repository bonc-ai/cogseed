# CogSeed-only Brand Cutover Design

- Date: 2026-08-18
- Base: `origin/develop` at `ecb5604d578ad363b5146c21f2a09a2582cc0fc6`
- Status: Approved for implementation

## Goal

Make CogSeed the only supported product identity in the repository and runtime. Remove the Orkas and Mate compatibility layers rather than translating them at startup or accepting them as aliases.

## Hard boundaries

This is intentionally a breaking cutover:

- Old `orkas://` and `mateagent://` deep links stop working.
- `ORKAS_*` environment variables stop working; only `COGSEED_*` is accepted.
- Old `.orkas` / `.orkas-dev` roots are not migrated automatically.
- Old `orkas.*`, `mate_agent.*`, and `window.mateAgentProjection` interfaces are removed.
- Old storage, IPC, DOM MIME, localStorage, event, prompt, and protocol prefixes are renamed to CogSeed forms.
- Legacy `orkas-*` / `mate-*` wrappers are removed from the shipped surface.
- The remote API base is no longer `https://orkas.ai/api`; runtime configuration requires `COGSEED_API_BASE_URL`.

No destructive deletion of an existing user's files is performed by the application. The application simply stops discovering legacy roots; users must manually back up or migrate old data before upgrading.

## Canonical naming

| Area | Canonical form |
| --- | --- |
| Product | `CogSeed` |
| Lowercase identifier | `cogseed` |
| App id | `com.cogseed.desktop` |
| Connector scheme | `cogseed://` |
| Runtime variant | `cogseed` |
| Environment prefix | `COGSEED_` |
| Workspace namespace | `cogseed` |
| Artifact reserved namespace | `__cogseed/` and `__cogseed-meta.json` |
| File drag MIME | `application/x-cogseed-file` |
| Renderer event prefix | `cogseed:` / `cogseed-*` |
| HTTP client headers | `CogSeed-*` |

## Implementation areas

1. **Identity and bootstrap**
   - Simplify `resources/identity.json` and `main/brand.ts` to canonical fields only.
   - Remove legacy normalization, runtime aliases, migration markers, and old protocol registration.
   - Rename package metadata fields from `orkas*` to `cogseed*` where they are internal metadata.

2. **Environment and paths**
   - Rename every production/test/script `ORKAS_*` reference to `COGSEED_*`.
   - Rename internal data namespaces and runtime directories that are product prefixes.
   - Keep no fallback reads from legacy environment variables or roots.

3. **IPC and renderer bridge**
   - Register only `cogseed.invoke`, `cogseed.streamStart`, and `cogseed.streamCancel`.
   - Rename `mate_agent.*` channels and remove the old projection object.
   - Update renderer storage keys, DOM MIME, custom events, CSS/data attributes, and locale keys.

4. **CLI and shipped wrappers**
   - Rename canonical bridge/package/runtime scripts to CogSeed names.
   - Remove legacy wrapper files from source and electron-builder packaging.
   - Update all skill and connector transport templates.

5. **API and user-facing text**
   - Rename HTTP headers and old runtime labels.
   - Require `COGSEED_API_BASE_URL`; do not guess or hard-code a new domain.
   - Remove old names from prompts, locales, README, docs, and generated metadata.

6. **Tests and fixtures**
   - Rewrite tests to assert CogSeed-only behavior.
   - Add negative tests proving legacy schemes, env vars, IPC channels, roots, and wrappers are rejected/absent.
   - Add a repository residual scan that excludes only external integration names and historical documentation explicitly marked as archival.

## Error and migration behavior

- Startup with a legacy-only environment fails with a clear `COGSEED_* required` error instead of silently normalizing it.
- A legacy deep link is rejected as an unsupported scheme.
- A legacy IPC channel returns `unknown channel` because no alias is registered.
- Existing `.orkas` data is not read or copied.
- Missing `COGSEED_API_BASE_URL` produces a clear configuration error for remote config and Marketplace operations.

## Verification gates

Before completion:

- `npm run typecheck`
- `npm run test:resources`
- `node --check` across shipped JavaScript files
- `npm run builtin:manifest:check`
- P3394 gateway smoke tests
- Full JS suite with the embedding model available
- Repository-wide residual scan for Orkas/Mate identifiers
- Renderer invoke/stream channel parity scan
- Package metadata and electron-builder file-list inspection

## Non-goals

- No redesign of the product IA.
- No change to P3394, KSTAR, Recall, connector, or messaging business semantics beyond identity names.
- External Agent brands such as Hermes, Claude, Codex, OpenClaw, and WorkBuddy remain because they identify integrations, not CogSeed's product identity.
- Protocol names P3394, KSTAR, and NSEAP remain because they are feature/protocol names, not legacy product aliases.
