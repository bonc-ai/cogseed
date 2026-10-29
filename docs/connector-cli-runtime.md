# Managed connector CLI runtimes

Feishu, DingTalk and WeCom prepare their native CLI when the user chooses **Install and connect**.
Preparation is explicit IPC (`connectors.prepare_runtime`), never a startup or model-tool side effect.
The page shows download/verification/installation progress, supports cancellation and retry, and
starts the existing authorization flow only after preparation succeeds for the same active account.
Tencent Meeting retains its existing packaged runtime flow; remote MCP connectors are unaffected.

## Distribution and trust

`src/main/features/connectors/cli-runtime-manifest.json` pins version, platform, archive integrity,
executable SHA-256, exact members and source URLs. Sources checked on 2026-10-09:

- Feishu 1.0.97: official `larksuite/cli` GitHub release and the npmmirror binary URL used by the
  official `@larksuite/cli` installer. Both sources use the same release checksum.
- DingTalk 1.0.63: `dingtalk-workspace-cli` on npm, selecting the platform-specific archive under
  `package/assets`. Its package install hooks and bundled Agent skills are not executed or installed.
- WeCom 1.3.4: platform-specific `@wecom/cli-*` packages on npm.

Supported assets: macOS arm64/x64 and Windows x64; Feishu and DingTalk also provide Windows arm64.
WeCom automatic installation is unavailable on Windows arm64. Existing external installations remain
usable through the previous probes. No global Node/npm installation or new npm dependency is needed.

npm packages prefer npmmirror with the original npm registry as fallback, always against the same
pinned integrity value. Downloads are bounded, verified before parsing and staged next to the destination. Only named normal
files are read; archive paths never become extraction destinations. The executable hash is checked
before promotion and again when the binary changes. Interrupted downloads never become ready.
Licenses (and DingTalk's NOTICE) accompany the executable. Updating a version requires verifying the
vendor release, all archive layouts and both checksum layers; do not replace pins with `latest`.

## Runtime and account boundaries

Executables live under `<uid>/local/connectors/runtimes/<provider>/<version>-<platform>-<arch>`.
Vendor credential homes and transient authorization files live under that account's connector
`cli-state` directory. The same scoped transport is used for login, reconnect and tool calls.
Credentials remain vendor-owned. The bridge is launched by `mcp-client.ts`; the installer spawns no
processes. Per-account storage and a child process do not constitute an OS sandbox.

Tests cover archive validation, corruption repair, deduplication, cancellation, retries, account
isolation and the page's prepare-before-authorize contract. Native Windows execution still requires
Windows verification; inspecting Windows archives on macOS does not prove they run on Windows.
