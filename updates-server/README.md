# CogSeed updates server

Standalone, zero-dependency release catalog API for the in-app update reminder
feature. Serves the contract documented in `docs/design/updates-api.md`; the
client implementation lives in `src/main/features/updater/`.

Production deployment target: `https://cogseed-open.bonc.com.cn/updates/latest` — packaged
client builds default their API base to `https://cogseed-open.bonc.com.cn` (env
`COGSEED_API_BASE_URL` still overrides for staging/local runs).

## Quick start

```sh
# 1. Publish an installer (computes sha256/size, copies it to downloads/,
#    updates releases.json)
node updates-server/publish.cjs dist/CogSeed-0.0.6-mac-arm64.dmg \
  --notes "修复若干问题，新增 XX 功能"

# 2. Run the server
UPDATES_SERVER_PUBLIC_BASE=https://updates.example.com \
  PORT=4870 node updates-server/server.cjs
```

Production MUST set `UPDATES_SERVER_PUBLIC_BASE` to an https origin — the
client refuses non-https download URLs.

## API

### `GET /updates/latest`

Reads client metadata from request headers (same headers the client always
sends via `withCommonHeaders`):

| Header | Example |
|---|---|
| `CogSeed-App-Version` | `0.0.5` |
| `CogSeed-Platform` | `darwin` / `win32` / `linux` |
| `CogSeed-Arch` | `arm64` / `x64` |
| `CogSeed-Channel` | `open` |

Responses (envelope):

```json
{ "code": 0, "data": { "latest_version": "0.0.6", "url": "https://…/downloads/CogSeed-0.0.6-mac-arm64.dmg", "sha256": "…", "size": 123, "notes": "…", "released_at": "…", "mandatory": false } }
{ "code": 0, "data": null }
```

`data` is null when the caller is already on the newest release for its
platform/arch. Version ordering uses the exact same token semantics as the
client comparator (`lib/compare-versions.cjs` ↔
`src/main/util/app-version-compat.ts`; a parity test enforces this).

### `GET /downloads/<file>`

Static installer artifacts. Path-traversal safe (rejects `..` and nested
paths). Serves only files physically present in `downloads/`.

### `GET /healthz`

`{ "ok": true }`

## Publish workflow

```sh
node updates-server/publish.cjs <installer-file> [--version v] [--platform p] [--arch a] \
  [--notes "..."] [--mandatory] [--min-app-version v] [--catalog path] [--no-copy]
```

- `version` / `platform` / `arch` are inferred from the artifact filename
  (`CogSeed-<version>-<os>-<arch>.<ext>`, os: `mac`→`darwin`, `win`→`win32`,
  `linux`→`linux`); pass them explicitly for non-standard names.
- The artifact is copied into `downloads/` (unless `--no-copy`) and the
  catalog entry is upserted atomically — re-publishing the same
  version+platform+arch replaces the previous entry.
- **Commit `releases.json` after publishing**, and make sure the artifact is
  reachable at `{UPDATES_SERVER_PUBLIC_BASE}/downloads/<file>`.
- `downloads/` is git-ignored (large binaries); the server can also serve
  artifacts placed there by your release pipeline.

## Env

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4870` | listen port |
| `UPDATES_SERVER_PUBLIC_BASE` | `http://127.0.0.1:4870` | origin used for download URLs; https in production |
| `UPDATES_CATALOG` | `updates-server/releases.json` | catalog path |

## Tests

```sh
node --test updates-server/test/          # catalog + HTTP integration (node:test)
npm run test:updates-server               # same, via npm
npm test                                  # also runs the client↔server parity test
```

## Deployment notes

- Zero npm dependencies — deploy with any Node ≥ 18 runtime (plain
  `node server.cjs`), or place it behind a reverse proxy for TLS.
- If your official backend is a different stack, treat this directory as the
  reference implementation: the contract, catalog shape, and version
  semantics are all defined here and in `docs/design/updates-api.md`.
