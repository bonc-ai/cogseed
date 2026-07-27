# Meta Skill Engine 单一 KSTAR 核心迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `$superpower-subagents` (recommended) or `$superpower-executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via `update_plan`.

**Goal:** 将已批准的 Meta Skill Engine 纳入仓库并切换为唯一 KSTAR 事实源，同时保留现有 P3394 Wake/IPC/Renderer 产品契约、用户数据边界和恢复能力。

**Architecture:** Engine 作为 `packages/nseap-meta-skill-engine/` 下独立的 ESM/MCP stdio 包，独占 Episode、EvidenceBundle、Attribution、Patch、Governance、Registry 和 snapshot 状态机。PC 只通过现有 `McpConnection` 建立 stdio 连接，负责用户隔离存储、snapshot CAS/原子写、pending evidence、迁移归档、兼容 DTO、Wake/Bus 和 UI；PC 不重新计算 KSTAR 语义。

**Tech Stack:** TypeScript ESM、Node MCP SDK、Zod、`yaml@^2.6.1`、Vitest（通过 Electron Node runtime）、Electron IPC、现有 `async-mutex`/storage/path helpers。

---

## 执行前约束

1. 本计划以 `docs/superpowers/specs/2026-07-26-meta-skill-engine-single-core-design.md` 为批准规格；该规格已经批准 `yaml@^2.6.1`。
2. 当前工作区已有未提交的 group-chat/P3394 定向修复和多份计划/报告文件。执行计划前必须先阅读 `git diff`，不得 reset、checkout 或覆盖这些改动；每个提交只包含本任务新增或明确列出的文件。
3. 旧 `src/main/features/p3394/kstar-runtime.ts` 在 Batch 2 完成前只允许作为 shadow-read 对照，不得与新 Engine 双写生产数据；只有删除门槛全部满足后才能删除。
4. Engine 运行时不得从 `userWorkSpace/meta-skill-engine-package/` 读取文件，也不得从 `resources/builtin/` 读取运行时内容。该目录只作为 Batch 1a 的输入来源，最终源码必须进入 `packages/nseap-meta-skill-engine/` 并由 Git 跟踪。
5. 所有涉及用户数据的 PC 函数签名都以 `userId` 为第一个参数；所有 MCP stdio 子进程都通过 `src/main/features/connectors/mcp-client.ts` 的 `McpConnection` choke point 启动。

## 文件地图

### Engine 包

- Create: `packages/nseap-meta-skill-engine/package.json` — 独立 ESM 包、`1.0.0` engine version、`--stdio` 启动入口和包级 build/test/check scripts。
- Create: `packages/nseap-meta-skill-engine/tsconfig.json` — 独立 TypeScript 编译边界，排除 `dist`/`node_modules`。
- Create: `packages/nseap-meta-skill-engine/src/index.ts` — MCP server、tool catalog、stdio-only product entrypoint。
- Create: `packages/nseap-meta-skill-engine/src/config/engine-config.ts` — engine/protocol/snapshot schema/capability 常量。
- Create: `packages/nseap-meta-skill-engine/src/types/index.ts` — 原型核心类型，迁移后只由 Engine 使用。
- Create: `packages/nseap-meta-skill-engine/src/types/snapshot.ts` — snapshot envelope、generation、migration、tool result 类型。
- Create: `packages/nseap-meta-skill-engine/src/persistence/snapshot-state.ts` — 进程内 snapshot 状态、generation CAS 和幂等 evidence index。
- Create: `packages/nseap-meta-skill-engine/src/persistence/canonical-json.ts` — tools hash/state hash 的稳定序列化。
- Create: `packages/nseap-meta-skill-engine/src/migration/snapshot-migrations.ts` — 连续 snapshot schema migration 链。
- Create: `packages/nseap-meta-skill-engine/src/migration/legacy-pc-import.ts` — `import_legacy_pc_kstar` dry-run/import 归一化。
- Create: `packages/nseap-meta-skill-engine/src/modules/ontology-reader.ts` — YAML ontology reader，复用原型语义但使用仓库包内资源。
- Create: `packages/nseap-meta-skill-engine/src/modules/evidence-collector.ts` — interaction/evidence/episode/bundle 创建。
- Create: `packages/nseap-meta-skill-engine/src/modules/attribution-engine.ts` — Attribution 和 route recommendation。
- Create: `packages/nseap-meta-skill-engine/src/modules/patch-generator.ts` — bounded patch proposal。
- Create: `packages/nseap-meta-skill-engine/src/modules/governance-gates.ts` — governance state machine。
- Create: `packages/nseap-meta-skill-engine/src/modules/skill-creator.ts` — 原型已有 skill/eval 工具，保持其独立能力。
- Create: `packages/nseap-meta-skill-engine/src/modules/registry-manager.ts` — Engine registry/version history。
- Create: `packages/nseap-meta-skill-engine/src/utils/ids.ts` — stable id/hash helper；对跨重试 evidence 使用调用方传入的 stable id。
- Create: `packages/nseap-meta-skill-engine/ontologies/university_paper_writing/*` — 原型 ontology YAML，随包发布。
- Create: `packages/nseap-meta-skill-engine/references/*`、`agents/*`、`SKILL.md`、`README.md` — Engine 文档和非运行时素材。
- Create: `packages/nseap-meta-skill-engine/test/*.test.ts` — Engine contract、snapshot、migration、ontology、MCP process tests。

### PC 适配与数据

- Create: `src/main/features/p3394/kstar-store.ts` — `<uid>/local/kstar` 路径、snapshot、`.previous`、pending JSONL、archive 读写和 per-uid mutex。
- Create: `src/main/features/p3394/kstar-adapter.ts` — Engine MCP lifecycle、握手、capability/tool hash 检查、mutation CAS、degraded/recovery。
- Create: `src/main/features/p3394/kstar-compat.ts` — Engine `project_compat_view` 到现有 KSTAR DTO 的只读投影。
- Create: `src/main/features/p3394/kstar-migration.ts` — 旧 `local/p3394/kstar-state.json` 的 dry-run、迁移、archive、stamp、rename。
- Modify: `src/main/features/connectors/mcp-client.ts` — 增加安全的本地 stdio `McpConnection` factory，不新增第二个 spawn 实现。
- Modify: `src/main/features/p3394/types.ts`、`index.ts` — 移除旧 runtime 类型依赖，导出 Wake/协议和新适配层类型。
- Modify: `src/main/features/p3394/kstar-kb.ts`、`kstar-notion.ts` — 由 Engine IDs/projection 驱动，Notion 以 `experience_id` 幂等。
- Modify: `src/main/features/group_chat/bus.ts`、`visibility.ts` — evidence 进入 adapter，保留既有 KSTAR required/skip/Wake 语义。
- Modify: `src/main/features/p3394/wake-service.ts`、`wake-controller.ts`、`wake-store.ts` — 保存并原样恢复 KSTAR contract。
- Modify: `src/main/ipc/index.ts` — 保留旧 IPC 名称，增加只读 archive IPC，全部走 compat/adapter。
- Modify: `src/main/index.ts` 或现有 boot registration 区域 — 通过 `util/boot_init.ts` 注册 Engine health/replay/migration 初始化，不使用 raw timer/IIFE。

### 构建与 UI

- Modify: `package.json`、`package-lock.json` — 根运行时依赖 `yaml@^2.6.1`、Engine build/test/smoke scripts、打包文件声明。
- Modify: `scripts/ensure-dev-dependencies.cjs`、`scripts/ensure-runtime-before-pack.cjs` — 开发启动和 packaging 前构建/验证 Engine。
- Modify: `run.sh` — 从仓库 `packages/nseap-meta-skill-engine/dist/index.js --stdio` 配置 KSTAR，不再指向 user workspace 副本。
- Modify: `src/renderer/modules/conversation.js`、`conversation-info.js`、相关 locale/CSS — 保持 active KSTAR UI，增加只读“历史 KSTAR”和 degraded/migration 状态。
- Modify/Create: `test/main/features/p3394/*`、`test/main/ipc/*`、`test/renderer/*`、`test/static/*` — Engine-backed fixtures、恢复/迁移/归档和删除证明。

---

## Batch 1a：前置依赖与 Engine 入库，不切流量

### Task 1: 将 Meta Skill Engine 原型转为仓库受控包

**Files:**
- Create: `packages/nseap-meta-skill-engine/` 下文件地图中列出的 package/source/ontology/reference 文件。
- Modify: `package.json`, `package-lock.json`。
- Test: `packages/nseap-meta-skill-engine/test/package-layout.test.ts`。

- [ ] **Step 1: Write the failing package-layout test**

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('NSEAP Meta Skill Engine package layout', () => {
  it('has tracked source and ontology inputs but no runtime dependency on userWorkSpace', () => {
    expect(existsSync(path.join(root, 'src/index.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'src/modules/evidence-collector.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'ontologies/university_paper_writing/scene_tbox.yaml'))).toBe(true);
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain('"type": "module"');
  });
});
```

- [ ] **Step 2: Run the test and confirm the package is absent**

Run: `npm exec vitest run packages/nseap-meta-skill-engine/test/package-layout.test.ts`

Expected: FAIL because `packages/nseap-meta-skill-engine/` does not exist yet.

- [ ] **Step 3: Copy only source-controlled Engine inputs**

Copy `userWorkSpace/meta-skill-engine-package/{src,ontologies,references,agents,SKILL.md,README.md,tsconfig.json}` into `packages/nseap-meta-skill-engine/`. Do not copy `dist/`, `node_modules/`, evaluator output, or the nested `package-lock.json`. Set `package.json` to package name `nseap-meta-skill-engine`, version `1.0.0`, ESM, and keep `yaml` as the ontology reader dependency. Add package scripts:

```json
{
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "check": "tsx scripts/check-engine.ts",
  "start": "node dist/index.js --stdio"
}
```

Add root scripts `engine:build`, `engine:test`, and `engine:check` that invoke the package scripts without changing the root test runner's Electron ABI behavior. Add root `yaml: "^2.6.1"` and regenerate `package-lock.json` with `npm install --package-lock-only`.

- [ ] **Step 4: Run the package layout and type/build checks**

Run: `npm exec vitest run packages/nseap-meta-skill-engine/test/package-layout.test.ts && npm run engine:build && npm run engine:check`

Expected: PASS; `packages/nseap-meta-skill-engine/dist/index.js` is generated and `check-engine` reads ontology resources from the package path.

- [ ] **Step 5: Commit the isolated package intake**

```bash
git add packages/nseap-meta-skill-engine package.json package-lock.json
git commit -m "feat: add repository Meta Skill Engine package"
```

### Task 2: 建立 Engine snapshot、generation CAS 和稳定 hash 合同

**Files:**
- Create: `packages/nseap-meta-skill-engine/src/types/snapshot.ts`
- Create: `packages/nseap-meta-skill-engine/src/persistence/canonical-json.ts`
- Create: `packages/nseap-meta-skill-engine/src/persistence/snapshot-state.ts`
- Modify: `packages/nseap-meta-skill-engine/src/types/index.ts`
- Test: `packages/nseap-meta-skill-engine/test/snapshot-contract.test.ts`, `generation-cas.test.ts`, `idempotent-evidence.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { SnapshotState, SnapshotGenerationConflict } from '../src/persistence/snapshot-state.js';

describe('Engine snapshot contract', () => {
  it('increments generation exactly once and rejects stale base_generation', () => {
    const state = new SnapshotState();
    const first = state.mutate({ base_generation: 0 }, current => ({ ...current, marker: 'first' }));
    expect(first.snapshot.generation).toBe(1);
    expect(() => state.mutate({ base_generation: 0 }, current => current)).toThrow(SnapshotGenerationConflict);
  });

  it('deduplicates the same evidence id without creating a second episode', () => {
    const state = new SnapshotState();
    const first = state.recordEvidence({ base_generation: 0, evidence_id: 'ev-stable', episode: { task: 'same' } });
    const replay = state.recordEvidence({ base_generation: 1, evidence_id: 'ev-stable', episode: { task: 'same' } });
    expect(replay.created).toBe(false);
    expect(replay.snapshot.state.episodes).toHaveLength(1);
    expect(first.snapshot.state.episodes[0].episode_id).toBe(replay.snapshot.state.episodes[0].episode_id);
  });
});
```

- [ ] **Step 2: Run the tests to verify the contracts fail**

Run: `npm exec vitest run packages/nseap-meta-skill-engine/test/snapshot-contract.test.ts packages/nseap-meta-skill-engine/test/generation-cas.test.ts packages/nseap-meta-skill-engine/test/idempotent-evidence.test.ts`

Expected: FAIL because `SnapshotState` and the snapshot types do not exist.

- [ ] **Step 3: Implement the minimal opaque snapshot state**

Define these exact public types in `src/types/snapshot.ts`:

```ts
export interface SnapshotEnvelope {
  engine_schema_version: string;
  engine_version: string;
  protocol_version: string;
  generation: number;
  kstar_timestamp: string;
  state: unknown;
  state_hash: string;
}

export interface MutationInput { base_generation: number }
export interface MutationResult { snapshot: SnapshotEnvelope; operation_id: string; created?: boolean }
export const SNAPSHOT_GENERATION_CONFLICT = 'E_SNAPSHOT_GENERATION_CONFLICT' as const;
```

`SnapshotState.mutate` must compare `base_generation` before applying a mutation, produce `base_generation + 1` exactly, calculate `state_hash` from canonical JSON, and throw an error carrying `code === E_SNAPSHOT_GENERATION_CONFLICT`. `recordEvidence` must index stable `evidence_id` and return the existing episode/bundle mapping on replay without appending a second object. No PC path or uid may enter Engine state.

- [ ] **Step 4: Add import/export/validate behavior and verify it**

Implement `exportSnapshot`, `importSnapshot`, and `validateSnapshot`. `importSnapshot` rejects malformed envelopes, invalid hash, negative generation, missing versions, and snapshot schema newer than the current Engine schema. `exportSnapshot` returns a deep-cloned envelope so callers cannot mutate Engine-owned state. Run:

```bash
npm exec vitest run packages/nseap-meta-skill-engine/test/snapshot-contract.test.ts packages/nseap-meta-skill-engine/test/generation-cas.test.ts packages/nseap-meta-skill-engine/test/idempotent-evidence.test.ts
npm run engine:build
```

Expected: all tests PASS and TypeScript emits declarations/maps into `dist/`.

- [ ] **Step 5: Commit the Engine state contract**

```bash
git add packages/nseap-meta-skill-engine/src/types packages/nseap-meta-skill-engine/src/persistence packages/nseap-meta-skill-engine/test
git commit -m "feat: add Meta Skill Engine snapshot generation contract"
```

### Task 3: Expose MCP stdio health, tool catalog hash and snapshot tools

**Files:**
- Modify: `packages/nseap-meta-skill-engine/src/index.ts`, `src/config/engine-config.ts`
- Create: `packages/nseap-meta-skill-engine/src/persistence/tool-catalog.ts`
- Create: `packages/nseap-meta-skill-engine/test/mcp-contract.test.ts`, `test/mcp-process.test.ts`

- [ ] **Step 1: Add failing MCP contract tests**

The tests must launch `dist/index.js --stdio` through the test Node executable, connect with the MCP SDK, and assert the following exact tool names are present: `get_engine_info`, `validate_snapshot`, `import_snapshot`, `export_snapshot`, `migrate_snapshot`, `record_evidence_bundle`, `list_episodes`, `get_episode`, `list_experience_candidates`, `review_experience_candidate`, `list_patch_proposals`, `review_patch_proposal`, `import_legacy_pc_kstar`, and `project_compat_view`. Assert that `get_engine_info` returns `engine_name`, `engine_version`, `protocol_version`, `snapshot_schema_version`, `tools_hash`, and the five capabilities from the approved spec.

```ts
expect(info.capabilities).toEqual(expect.arrayContaining([
  'snapshot_import_export', 'snapshot_migration', 'legacy_pc_import',
  'compatibility_projection', 'governance',
]));
expect(info.protocol_version.split('.')[0]).toBe('1');
expect(typeof info.tools_hash).toBe('string');
```

- [ ] **Step 2: Run the MCP tests and confirm the old server contract fails**

Run: `npm run engine:build && npm exec vitest run packages/nseap-meta-skill-engine/test/mcp-contract.test.ts packages/nseap-meta-skill-engine/test/mcp-process.test.ts`

Expected: FAIL because the current prototype lacks `--stdio` gating, `get_engine_info`, snapshot tools, and the required tool metadata.

- [ ] **Step 3: Implement one catalog and one mutation wrapper**

Create `TOOL_CATALOG` as the only source for exposed tool names and schemas. Compute `tools_hash` from canonical JSON of the catalog, not from object insertion order. Route every mutating tool through a wrapper that requires `base_generation`, calls the Engine state mutation, and returns the complete snapshot envelope plus `operation_id`. Return `E_SNAPSHOT_GENERATION_CONFLICT` without implicit merge when the base is stale.

Add the system tools to `src/index.ts`; retain the prototype ontology/evidence/attribution/patch/governance/registry tools but route their state changes through the same wrapper. `get_engine_info` must be read-only. `project_compat_view` must be the only compatibility projection entrypoint.

- [ ] **Step 4: Enforce product startup mode and test the process boundary**

Implement `main(argv)` so `--stdio` starts `StdioServerTransport`; no flag may be used by the PC adapter to start a different mode. CLI health/help may remain available for manual use, but product mode is the fixed command `node packages/nseap-meta-skill-engine/dist/index.js --stdio`. Ensure stderr contains only non-sensitive health messages and never snapshot/evidence content.

Run:

```bash
npm run engine:build
npm exec vitest run packages/nseap-meta-skill-engine/test/mcp-contract.test.ts packages/nseap-meta-skill-engine/test/mcp-process.test.ts
```

Expected: PASS, including process close/restart and snapshot export/import round trip.

- [ ] **Step 5: Commit the MCP contract**

```bash
git add packages/nseap-meta-skill-engine/src packages/nseap-meta-skill-engine/test
git commit -m "feat: expose versioned Meta Skill Engine MCP contract"
```

### Task 4: 接入 ontology、snapshot migration 和 legacy import

**Files:**
- Create: `packages/nseap-meta-skill-engine/src/migration/snapshot-migrations.ts`
- Create: `packages/nseap-meta-skill-engine/src/migration/legacy-pc-import.ts`
- Modify: `packages/nseap-meta-skill-engine/src/modules/ontology-reader.ts`, `src/index.ts`
- Test: `packages/nseap-meta-skill-engine/test/ontology-reader.test.ts`, `snapshot-migration.test.ts`, `legacy-import.test.ts`
- Fixture: `packages/nseap-meta-skill-engine/test/fixtures/legacy/*.json`

- [ ] **Step 1: Add fixtures and failing migration/import tests**

Create fixtures for one complete legacy run with `kstar_episode`, one incomplete run, four approved and one rejected experience, five generic patch candidates, corrupted JSON, and a file with no legacy runs. Tests must assert dry-run counts, source IDs, timestamps, evidence refs, and rejection reasons.

```ts
const result = await importLegacyPcKStar(fixture, { dry_run: true });
expect(result.counts).toEqual({
  episodes_migrated: 1,
  runs_archived: 1,
  experiences_imported_as_draft: 1,
  patches_archived: 1,
});
expect(result.imports[0].governance.authority_level).toBe('draft');
expect(result.imports[0].governance.non_claim_note).toContain('Legacy Delta');
expect(result.archives[0].reason).toContain('incomplete');
```

- [ ] **Step 2: Run fixture tests and confirm migration is not implemented**

Run: `npm exec vitest run packages/nseap-meta-skill-engine/test/ontology-reader.test.ts packages/nseap-meta-skill-engine/test/snapshot-migration.test.ts packages/nseap-meta-skill-engine/test/legacy-import.test.ts`

Expected: FAIL on missing migration/import functions or incorrect counts.

- [ ] **Step 3: Implement ontology loading and continuous snapshot migration**

Make `OntologyReader` resolve package-local ontology resources by default and accept only opaque ontology IDs/slices from PC. Implement a version-keyed migration map. For `schema < current`, apply every intermediate migration in order and return `from_schema_version`, `to_schema_version`, `migrated_snapshot`, `migration_steps`, and `warnings`. For `schema > current`, return `snapshot_from_newer_engine` and never downgrade or rewrite the input.

- [ ] **Step 4: Implement legacy dry-run/import semantics**

`import_legacy_pc_kstar` must import only complete runs with `kstar_episode` and approved experiences as `authority_level: draft`; preserve legacy source IDs/timestamps and add the fixed `non_claim_note`. It must archive incomplete runs, rejected experiences, all old patches, old UI/verification state, and unassociated evidence. It must never trust old `delta_a`/`delta_r`, activate old patches, or treat old approved data as released. Deduplicate repeated imports by legacy source ID without creating a second episode.

Run:

```bash
npm exec vitest run packages/nseap-meta-skill-engine/test/ontology-reader.test.ts packages/nseap-meta-skill-engine/test/snapshot-migration.test.ts packages/nseap-meta-skill-engine/test/legacy-import.test.ts
npm run engine:build && npm run engine:check
```

Expected: PASS; invalid and newer snapshots are rejected/degraded without mutation.

- [ ] **Step 5: Commit Engine migration support**

```bash
git add packages/nseap-meta-skill-engine/src packages/nseap-meta-skill-engine/test
git commit -m "feat: add snapshot and legacy KSTAR migration contracts"
```

### Task 5: 统一构建、开发启动和打包内容

**Files:**
- Modify: `scripts/ensure-dev-dependencies.cjs`
- Modify: `scripts/ensure-runtime-before-pack.cjs`
- Modify: `run.sh`
- Modify: `package.json`
- Test: `test/static/meta-skill-engine-packaging.test.ts`

- [ ] **Step 1: Add failing build-boundary tests**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('Meta Skill Engine packaging boundary', () => {
  it('packages repository Engine dist and ontology, not userWorkSpace', () => {
    const files = pkg.build.files.join('\n');
    expect(files).toContain('packages/nseap-meta-skill-engine/**/*');
    expect(files).not.toContain('userWorkSpace/meta-skill-engine-package');
  });
});
```

- [ ] **Step 2: Run the static test and confirm current paths fail**

Run: `npm exec vitest run test/static/meta-skill-engine-packaging.test.ts`

Expected: FAIL because `run.sh` and the packaging file list still reference the user-workspace engine or omit the repository package.

- [ ] **Step 3: Make one fixed Engine build/configuration path**

`ensure-dev-dependencies.cjs` must run the package `tsc` build and fail if `dist/index.js`, package manifest, or ontology directory is missing. `run.sh` must set:

```bash
KSTAR_ENGINE_DIR="$APP_DIR/packages/nseap-meta-skill-engine"
KSTAR_ENGINE_ENTRY="$KSTAR_ENGINE_DIR/dist/index.js"
export ORKAS_KSTAR_ENGINE_COMMAND="${ORKAS_KSTAR_ENGINE_COMMAND:-node}"
export ORKAS_KSTAR_ENGINE_ARGS="${ORKAS_KSTAR_ENGINE_ARGS:-[\"$KSTAR_ENGINE_ENTRY\",\"--stdio\"]}"
export ORKAS_KSTAR_ENGINE_CWD="${ORKAS_KSTAR_ENGINE_CWD:-$KSTAR_ENGINE_DIR}"
export ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR="${ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR:-$KSTAR_ENGINE_DIR/ontologies}"
```

Packaging must include `packages/nseap-meta-skill-engine/dist/**/*`, `packages/nseap-meta-skill-engine/ontologies/**/*`, and its manifest while excluding package `node_modules`, source test fixtures, and user workspace content. `ensure-runtime-before-pack.cjs` must verify that Engine build and ontology files exist before packaging.

- [ ] **Step 4: Verify source and package smoke**

Run:

```bash
npm run engine:build
npm exec vitest run test/static/meta-skill-engine-packaging.test.ts
./run.sh --help 2>/dev/null || true
npm run prepack
```

Expected: Engine build succeeds, static boundary test passes, source launcher resolves repository package, and prepack verification reports the Engine package as present. Do not claim packaged success until the later real packaging smoke in Task 12.

- [ ] **Step 5: Commit build boundary changes**

```bash
git add scripts/ensure-dev-dependencies.cjs scripts/ensure-runtime-before-pack.cjs run.sh package.json package-lock.json test/static/meta-skill-engine-packaging.test.ts
git commit -m "build: package repository Meta Skill Engine"
```

---

## Batch 1b：PC 基础适配与 shadow read

### Task 6: 实现用户隔离的 KSTAR store、原子 snapshot 和 pending evidence log

**Files:**
- Create: `src/main/features/p3394/kstar-store.ts`
- Test: `test/main/features/p3394/kstar-store.test.ts`

- [ ] **Step 1: Add failing store tests**

Cover these invariants in separate tests:

```ts
it('isolates snapshots and pending evidence by user id', async () => {
  await store.writeSnapshot('user-a', envelope(3));
  await store.writeSnapshot('user-b', envelope(7));
  expect((await store.readSnapshot('user-a'))?.generation).toBe(3);
  expect((await store.readSnapshot('user-b'))?.generation).toBe(7);
});

it('folds append-only evidence events and keeps unresolved records replayable', async () => {
  await store.appendPendingEvidence('user-a', pending('ev-1'));
  await store.appendPendingEvidence('user-a', failed('ev-1', true));
  expect((await store.readPendingEvidence('user-a'))[0].evidence_id).toBe('ev-1');
});
```

Also test that a failed snapshot rename leaves the previous complete snapshot, that compact preserves all unresolved items and the newest 500 imported/terminal events, and that archive list/detail never reads active snapshot state.

- [ ] **Step 2: Run the tests and confirm the store is absent**

Run: `npm exec vitest run test/main/features/p3394/kstar-store.test.ts`

Expected: FAIL because `kstar-store.ts` does not exist.

- [ ] **Step 3: Implement store paths and per-user mutex**

Use `userLocalRoot(userId)/kstar/` for `engine.json`, `snapshot.json`, `snapshot.json.previous`, `pending-evidence.jsonl`, `migration.json`, and `archives/`. Keep path derivation inside functions; never cache uid-derived roots at module scope. Use a mutex map keyed by `userId`; use existing `writeJson`/atomic rename helpers for JSON and temp-file-plus-rename for JSONL compact. `appendPendingEvidence` must append one JSON object per line and never rewrite an existing line.

- [ ] **Step 4: Implement fold/compact/archive APIs and verify failure recovery**

Export exact functions used by the adapter and IPC:

```ts
export async function readSnapshot(userId: string): Promise<SnapshotEnvelope | null>;
export async function writeSnapshot(userId: string, snapshot: SnapshotEnvelope): Promise<void>;
export async function appendPendingEvidence(userId: string, event: PendingEvidenceEvent): Promise<void>;
export async function readPendingEvidence(userId: string): Promise<PendingEvidenceRecord[]>;
export async function compactPendingEvidence(userId: string): Promise<void>;
export async function listArchivedKStarRuns(userId: string, cid?: string, cursor?: string, limit?: number): Promise<ArchivedKStarSummary[]>;
export async function getArchivedKStarRun(userId: string, archiveId: string): Promise<ArchivedKStarRecord | null>;
```

`readPendingEvidence` folds by `evidence_id` and returns only pending or retryable failed records. `compactPendingEvidence` permanently retains unresolved records, the newest 500 imported/terminal events, and one count/hash summary for older terminal events. Archive IDs must pass `safeId` before path resolution.

Run: `npm exec vitest run test/main/features/p3394/kstar-store.test.ts`

Expected: PASS, including simulated write failure and user isolation.

- [ ] **Step 5: Commit the PC store**

```bash
git add src/main/features/p3394/kstar-store.ts test/main/features/p3394/kstar-store.test.ts
git commit -m "feat: add isolated KSTAR snapshot and evidence store"
```

### Task 7: 通过现有 McpConnection 实现 Engine adapter 和 compat projection

**Files:**
- Modify: `src/main/features/connectors/mcp-client.ts`
- Create: `src/main/features/p3394/kstar-adapter.ts`
- Create: `src/main/features/p3394/kstar-compat.ts`
- Test: `test/main/features/p3394/kstar-adapter.test.ts`, `test/main/features/p3394/kstar-compat.test.ts`

- [ ] **Step 1: Add failing adapter tests with an injected connection double**

The double must expose `connect`, `listTools`, `callTool`, and `close`; tests must assert that production adapter asks for `get_engine_info` first, rejects a protocol-major mismatch, rejects a required capability missing from the handshake, and maps `E_SNAPSHOT_GENERATION_CONFLICT` to a retryable transaction result without last-write-wins.

```ts
it('does not calculate delta or route locally', async () => {
  const adapter = makeAdapter({
    callTool: vi.fn(async (name) => ({
      get_engine_info: engineInfo(),
      project_compat_view: { runs: [], experience_candidates: [], patch_candidates: [] },
    }[name])),
  });
  await adapter.projectCompatView('user-a', 'cid-a');
  expect(adapter.localScoringFunctions).toHaveLength(0);
  expect(mock.callTool).toHaveBeenCalledWith('project_compat_view', expect.any(Object), expect.anything());
});
```

- [ ] **Step 2: Run the tests and confirm no adapter exists**

Run: `npm exec vitest run test/main/features/p3394/kstar-adapter.test.ts test/main/features/p3394/kstar-compat.test.ts`

Expected: FAIL because the adapter, compat projection, and dedicated stdio factory do not exist.

- [ ] **Step 3: Add the single stdio factory to the MCP choke point**

In `mcp-client.ts`, export a factory that only constructs `McpConnection` from a `Transport` object and keeps SDK `StdioClientTransport` spawning inside that file. The adapter must not import `@modelcontextprotocol/sdk` or call `child_process.spawn`. Use the fixed transport values `command: 'node'`, args `[engineEntry, '--stdio']`, package cwd, and ontology env; allow test injection without changing production spawn ownership.

- [ ] **Step 4: Implement handshake, CAS transaction and degraded status**

Implement:

```ts
export type KStarRuntimeStatus =
  | 'ready'
  | 'degraded'
  | 'protocol_incompatible'
  | 'snapshot_from_newer_engine'
  | 'legacy_changed_after_migration';

export interface KStarAdapter {
  getStatus(userId: string): Promise<{ status: KStarRuntimeStatus; info?: EngineInfo; error_code?: string }>;
  recordEvidenceBundle(userId: string, input: EvidenceBundleInput): Promise<Record<string, unknown>>;
  closeCollaboration(userId: string, input: CloseCollaborationInput): Promise<Record<string, unknown>>;
  projectCompatView(userId: string, cid?: string): Promise<CompatProjection>;
  reviewExperienceCandidate(userId: string, candidateId: string, decision: 'approve' | 'reject'): Promise<CompatExperienceCandidate>;
  reviewPatchProposal(userId: string, proposalId: string, decision: 'approve' | 'reject', notes?: string): Promise<CompatPatchCandidate>;
}
```

Every mutation must lock the uid, load and validate snapshot, call `import_snapshot`, call the Engine mutation with the loaded generation, call `export_snapshot`, verify returned generation/hash, compare disk generation before write, and atomically write the new envelope. On Engine unavailable/import failure, append the original evidence to pending JSONL and set degraded status; do not fabricate pass/fail or local attribution. `projectCompatView` must return old DTOs only and must not expose opaque `state`.

- [ ] **Step 5: Verify and commit adapter/compat**

Run:

```bash
npm exec vitest run test/main/features/p3394/kstar-adapter.test.ts test/main/features/p3394/kstar-compat.test.ts
npm run typecheck
```

Expected: PASS; typecheck reports no import of the deleted legacy type from new adapter files.

```bash
git add src/main/features/connectors/mcp-client.ts src/main/features/p3394/kstar-adapter.ts src/main/features/p3394/kstar-compat.ts test/main/features/p3394/kstar-adapter.test.ts test/main/features/p3394/kstar-compat.test.ts
git commit -m "feat: add Engine-backed KSTAR adapter and compatibility projection"
```

### Task 8: 将 Bus evidence、Commander closure 和 Wake contract 接入 adapter

**Files:**
- Modify: `src/main/features/group_chat/bus.ts`, `src/main/features/group_chat/visibility.ts`
- Modify: `src/main/features/p3394/types.ts`, `wake-service.ts`, `wake-controller.ts`, `wake-store.ts`
- Test: `test/main/features/group_chat/bus-integration.test.ts`, `test/main/features/p3394/wake-service.test.ts`, `wake-controller.test.ts`, `wake-recovery.test.ts`, `test/main/features/p3394/kstar-adapter.test.ts`

- [ ] **Step 1: Add failing integration tests for exactly-once evidence flow**

Add tests that dispatch a required KSTAR Agent task, complete the Agent twice with the same stable evidence ID, and close the Commander collaboration once. Assert exactly one adapter mutation/Engine episode mapping, one pending/imported event pair, and no second continuation dispatch. Add a Wake approval/recovery test asserting the stored request preserves `required`, `reason`, full `expectation`, `source_actor_id`, `workflow_step_id`, and `workflow_resume_token` byte-for-byte.

```ts
expect(engine.recordEvidenceBundle).toHaveBeenCalledTimes(1);
expect(engine.closeCollaboration).toHaveBeenCalledTimes(1);
expect(request.kstar_decision).toEqual(originalDecision);
expect(request.workflow_resume_token).toBe('resume-token-1');
```

- [ ] **Step 2: Run focused tests and confirm the old runtime path is still observed**

Run: `npm exec vitest run test/main/features/group_chat/bus-integration.test.ts test/main/features/p3394/wake-service.test.ts test/main/features/p3394/wake-controller.test.ts test/main/features/p3394/wake-recovery.test.ts`

Expected: Existing tests pass, while the new adapter-call assertions fail because Bus still calls legacy KSTAR runtime/engine functions.

- [ ] **Step 3: Replace Bus writes with normalized Engine evidence inputs**

Keep Commander’s `kstar: required|skip` normalization and Bus Guard upgrade. Replace calls that create/update `KStarRun`, calculate `delta_r`, calculate `delta_a`, or locally route a patch with adapter input containing raw evidence, stable evidence ID, source actor, expected action/result, tool cycle metadata, and conversation/session IDs. The adapter writes pending evidence first, then calls `record_evidence_bundle`; PC must not create a custom `KStarRun`.

- [ ] **Step 4: Route terminal closure through Engine**

At the established Bus terminal signal, call `adapter.closeCollaboration` once per collaboration terminal token. The adapter passes pending evidence to Engine, which creates the final Episode/EvidenceBundle/Attribution/proposal/governance state. Keep Commander as evaluator/owner only; its validation text may remain product content but cannot write Engine status fields directly.

Modify Wake persistence so approval/rejection/execute transitions retain the original KSTAR contract and workflow resume fields. Approval recovery forwards the stored contract unchanged into the same adapter evidence pipeline; it must not reconstruct a new Episode in Wake code.

- [ ] **Step 5: Verify and commit integration**

Run:

```bash
npm exec vitest run test/main/features/group_chat/bus-integration.test.ts test/main/features/p3394/wake-service.test.ts test/main/features/p3394/wake-controller.test.ts test/main/features/p3394/wake-recovery.test.ts
```

Expected: PASS with one evidence mutation for duplicate terminal callbacks and preserved Wake metadata.

```bash
git add src/main/features/group_chat/bus.ts src/main/features/group_chat/visibility.ts src/main/features/p3394/types.ts src/main/features/p3394/wake-service.ts src/main/features/p3394/wake-controller.ts src/main/features/p3394/wake-store.ts test/main/features/group_chat/bus-integration.test.ts test/main/features/p3394/wake-service.test.ts test/main/features/p3394/wake-controller.test.ts test/main/features/p3394/wake-recovery.test.ts
git commit -m "feat: route group evidence and Wake recovery through KSTAR Engine"
```

---

## Batch 2：Migration 与 cutover

### Task 9: 实现 legacy migration transaction、stamp、archive 和多机器 dedupe

**Files:**
- Create: `src/main/features/p3394/kstar-migration.ts`
- Modify: `src/main/features/p3394/kstar-store.ts`, `kstar-adapter.ts`
- Test: `test/main/features/p3394/kstar-migration.test.ts`
- Fixture: `test/fixtures/p3394/kstar-migration/*.json`

- [ ] **Step 1: Add migration fixture tests before implementation**

Cover complete legacy state, incomplete run, approved/rejected experience, generic patch, corrupted source, failure before rename, completed matching hash, completed changed hash, in-progress retry, no legacy file, and two-user/two-machine source-hash dedupe. Assert that no new snapshot is written and no original rename occurs when any validation/write step fails.

```ts
it('does not rename the legacy source when archive installation fails', async () => {
  store.failNextArchiveInstall();
  await expect(migration.run('user-a')).rejects.toThrow();
  expect(await exists(legacyPath('user-a'))).toBe(true);
  expect(await readMigration('user-a')).not.toMatchObject({ status: 'completed' });
});

it('marks changed legacy data degraded instead of reimporting', async () => {
  const result = await migration.run('user-a');
  expect(result.status).toBe('legacy_changed_after_migration');
  expect(engine.importLegacy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run migration tests and confirm the transaction is absent**

Run: `npm exec vitest run test/main/features/p3394/kstar-migration.test.ts`

Expected: FAIL because migration orchestration and archive/stamp handling do not exist.

- [ ] **Step 3: Implement hash-based stamp and safe transaction order**

Use this exact order under the uid KSTAR mutex: read/hash source; Engine dry-run; validate counts/refs; write new snapshot temp; write archive temp; atomically install snapshot/archive/stamp; rename source to `kstar-state.legacy-2026-07-26.json`. On any error, remove only temp files, leave source untouched, omit completed stamp, preserve `migration_failed`, and let next boot retry.

Write `migration.json` with `migration_version`, `status`, `source_file`, `source_file_hash`, `archive_hash`, `snapshot_generation`, Engine/schema versions, timestamp, counts, migrated source IDs, and archived source IDs. Matching completed hash returns `already_migrated`; changed hash returns `legacy_changed_after_migration` without importing. Failed/in-progress state uses source/temp hashes to decide retry or rollback.

- [ ] **Step 4: Implement cloud experience dedupe without syncing local state**

When promotion later writes cloud context, use `source_episode_id + source_file_hash` as the dedupe key. Keep snapshot, pending log, migration stamp, and archive under local machine-private storage. Do not use OAuth uid to infer that two machines’ legacy content is identical.

Run: `npm exec vitest run test/main/features/p3394/kstar-migration.test.ts`

Expected: PASS for all nine fixture classes and idempotent repeated runs.

- [ ] **Step 5: Commit migration**

```bash
git add src/main/features/p3394/kstar-migration.ts src/main/features/p3394/kstar-store.ts src/main/features/p3394/kstar-adapter.ts test/main/features/p3394/kstar-migration.test.ts test/fixtures/p3394/kstar-migration
git commit -m "feat: migrate legacy KSTAR state with archive and stamps"
```

### Task 10: 切换 KB/Notion 到 Engine identity 和 promotion contract

**Files:**
- Modify: `src/main/features/p3394/kstar-kb.ts`
- Modify: `src/main/features/p3394/kstar-notion.ts`
- Modify: `src/main/features/p3394/kstar-adapter.ts`, `kstar-compat.ts`
- Test: `test/main/features/p3394/kstar-kb.test.ts`, `kstar-notion.test.ts`, `kstar-adapter.test.ts`

- [ ] **Step 1: Add failing identity/idempotency tests**

Assert generated KB markdown and Notion arguments contain `experience_id`, `source_episode_id`, `source_bundle_id`, `governance_decision_id`, `engine_version`, `promoted_by`, and optional `source_legacy_run_id`; assert they do not query Engine by new `source_run_id`. Call Notion sync twice and assert the second call returns the stored page without a second create-page tool call.

```ts
expect(markdown).toContain('experience_id: exp-123');
expect(markdown).toContain('source_episode_id: ep-123');
expect(createPage).toHaveBeenCalledTimes(1);
expect(second.page_id).toBe(first.page_id);
```

- [ ] **Step 2: Run focused tests and confirm old KStarRun dependency fails the new contract**

Run: `npm exec vitest run test/main/features/p3394/kstar-kb.test.ts test/main/features/p3394/kstar-notion.test.ts`

Expected: the existing happy-path tests may pass, but new identity/idempotency assertions fail because KB/Notion still consume `KStarRun.source_run_id` as their internal source.

- [ ] **Step 3: Make Engine projection the only promotion input**

Have KB promotion request the Engine compatibility candidate/projection by `experience_id`, use Engine-provided summary/governance/source IDs, then call existing `writeContextFileForUser`. Preserve the existing cloud path `<uid>/cloud/contexts/kstar-experiences/<year>/<month>/<experience-id>.md`. The old IPC `source_run_id` field is projected as `source_legacy_run_id` when present, otherwise `source_episode_id`; internal code never uses it for lookup.

- [ ] **Step 4: Make Notion sync experience-id idempotent**

Build page payload from Engine identity and existing markdown. Before creating a page, return stored sync metadata when candidate `notion_sync.status === 'synced'`; persist `experience_id` as the idempotency key in the local projection/result. On retry after a transport error, use the same key and do not create a duplicate page.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm exec vitest run test/main/features/p3394/kstar-kb.test.ts test/main/features/p3394/kstar-notion.test.ts test/main/features/p3394/kstar-adapter.test.ts
```

Expected: PASS with Engine IDs in both payloads and one Notion create operation per experience.

```bash
git add src/main/features/p3394/kstar-kb.ts src/main/features/p3394/kstar-notion.ts src/main/features/p3394/kstar-adapter.ts src/main/features/p3394/kstar-compat.ts test/main/features/p3394/kstar-kb.test.ts test/main/features/p3394/kstar-notion.test.ts test/main/features/p3394/kstar-adapter.test.ts
git commit -m "feat: use Engine identities for KSTAR promotion"
```

### Task 11: 保持旧 IPC 名称并增加只读 archive IPC

**Files:**
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/features/p3394/index.ts`
- Create: `test/main/ipc/p3394-kstar-engine-routes.test.ts`
- Modify: `test/main/ipc/p3394-patch-candidates.test.ts`
- Create: `test/main/ipc/p3394-archive.test.ts`

- [ ] **Step 1: Add route contract tests before rewiring**

Assert the existing names still validate `cid`/IDs and return the old DTO shape: `p3394.listKStarRuns`, `reviewKStarRun`, `listExperienceCandidates`, `decideExperienceCandidate`, `promoteExperienceCandidate`, `listPatchCandidates`, and `reviewPatchCandidate`. Add archive tests:

```ts
const listed = await call('p3394.listArchivedKStarRuns', { cid: 'cid-a', limit: 20 });
expect(listed.archived_runs[0]).toEqual(expect.objectContaining({ id: 'archive-1', conversation_id: 'cid-a' }));
await expect(call('p3394.getArchivedKStarRun', { archiveId: 'archive-1' })).resolves.toMatchObject({ ok: true });
await expect(call('p3394.reviewKStarRun', { cid: 'cid-a', runId: 'archive-1', decision: 'pass' })).rejects.toThrow();
```

- [ ] **Step 2: Run IPC tests and confirm new routes fail**

Run: `npm exec vitest run test/main/ipc/p3394-kstar-engine-routes.test.ts test/main/ipc/p3394-patch-candidates.test.ts test/main/ipc/p3394-archive.test.ts`

Expected: archive routes fail as unregistered, and existing route tests still expose legacy runtime writes.

- [ ] **Step 3: Rewire existing routes through compat/adapter**

In `src/main/ipc/index.ts`, keep route names and argument validation. `listKStarRuns` and list candidate routes call `project_compat_view`; review/decision routes call Engine governance mutation through adapter and then return the projected old DTO. Renderer must never receive opaque snapshot state. Archive routes call only `kstar-store` list/detail and never invoke Engine mutation.

- [ ] **Step 4: Enforce active/archive separation**

Exclude archive records from active runs, attention count, badge, active metrics, and benchmark projections. Use `safeId` for archive IDs and bounded `cursor`/`limit`; list summaries contain only id, legacy type/status, timestamp, conversation ID, and truncated summary, while detail returns the original legacy record and archive metadata.

- [ ] **Step 5: Verify and commit IPC contract**

Run:

```bash
npm exec vitest run test/main/ipc/p3394-kstar-engine-routes.test.ts test/main/ipc/p3394-patch-candidates.test.ts test/main/ipc/p3394-archive.test.ts
```

Expected: PASS; old IPC names remain callable, archive is read-only, and active attention counts exclude archived records.

```bash
git add src/main/ipc/index.ts src/main/features/p3394/index.ts test/main/ipc/p3394-kstar-engine-routes.test.ts test/main/ipc/p3394-patch-candidates.test.ts test/main/ipc/p3394-archive.test.ts
git commit -m "feat: preserve KSTAR IPC with Engine projections and archive history"
```

### Task 12: 更新 Renderer active/history/degraded 视图，不重写现有布局

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `src/renderer/modules/i18n.js` only if existing locale loading requires it
- Modify: `src/renderer/locales/*.json` and `src/renderer/style.css` for visible strings/styles
- Test: `test/renderer/p3394-experience-controls.test.ts`, `conversation-info.test.ts`, `p3394-patch-candidates.test.ts`, new `test/renderer/p3394-archive.test.ts`

- [ ] **Step 1: Add failing renderer contract tests**

Use existing renderer fixtures and assert: active cards render Engine-projected fields; archive records appear under a separate history section with no review/apply/promote buttons; `kstar_status=degraded` renders a non-destructive unavailable state; active attention count ignores archive.

```ts
expect(result.html).toContain('历史 KSTAR');
expect(result.html).toContain('Engine 暂不可用');
expect(result.html).not.toContain('data-kstar-review="pass"');
expect(result.attentionCount).toBe(1); // active only; archive contributes zero
```

- [ ] **Step 2: Run renderer tests and confirm history/degraded UI is absent**

Run: `npm exec vitest run test/renderer/p3394-experience-controls.test.ts test/renderer/conversation-info.test.ts test/renderer/p3394-patch-candidates.test.ts test/renderer/p3394-archive.test.ts`

Expected: new history/degraded assertions fail while existing active UI tests remain the compatibility baseline.

- [ ] **Step 3: Render only compatibility DTOs**

Keep the current `.chat-kstar-review` and experience/patch controls. Add a read-only history section driven by archive list/detail IPC results. Add explicit degraded/migration-failed labels via renderer locale files and re-render on `i18n-change`; do not put product strings directly in JS. Do not add a new renderer HTTP server or direct filesystem access.

- [ ] **Step 4: Remove archive mutation affordances and preserve active hydration**

Archive cards must not include `data-kstar-review`, experience decision, patch review, or Notion/KB promotion actions. Active hydration continues to use existing endpoints and only Engine projections. Keep shared UI classes/z-index rules; add no duplicate card system.

- [ ] **Step 5: Verify and commit UI**

Run:

```bash
npm exec vitest run test/renderer/p3394-experience-controls.test.ts test/renderer/conversation-info.test.ts test/renderer/p3394-patch-candidates.test.ts test/renderer/p3394-archive.test.ts
```

Expected: PASS with active UI unchanged in structure and archive/degraded states clearly separated.

```bash
git add src/renderer/modules/conversation.js src/renderer/modules/conversation-info.js src/renderer/locales src/renderer/style.css test/renderer/p3394-experience-controls.test.ts test/renderer/conversation-info.test.ts test/renderer/p3394-patch-candidates.test.ts test/renderer/p3394-archive.test.ts
git commit -m "feat: add read-only KSTAR history and degraded UI"
```

### Task 13: 注册 boot health/replay/migration，并完成 Engine-backed shadow read

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/features/p3394/kstar-adapter.ts`, `kstar-migration.ts`, `kstar-store.ts`
- Test: `test/main/features/p3394/kstar-recovery.test.ts`, `test/main/features/p3394/kstar-migration.test.ts`, `test/main/index-boot.test.ts` if an existing boot test harness is available

- [ ] **Step 1: Add failing boot/recovery tests**

Assert that boot registers work through `util/boot_init.ts`, Engine unavailable leaves ordinary chat/Agent/Wake usable, raw evidence is appended without logging content, recovery replays stable evidence IDs and compacts only after snapshot write, and a newer snapshot schema becomes degraded without overwrite.

```ts
expect(status.status).toBe('degraded');
expect(await store.readPendingEvidence('user-a')).toHaveLength(1);
await adapter.recover('user-a');
expect(engine.recordEvidenceBundle).toHaveBeenCalledTimes(1);
expect(await store.readSnapshot('user-a')).toMatchObject({ generation: 2 });
```

- [ ] **Step 2: Run focused recovery tests and confirm boot registration is missing**

Run: `npm exec vitest run test/main/features/p3394/kstar-recovery.test.ts test/main/features/p3394/kstar-migration.test.ts`

Expected: degraded/replay assertions fail until adapter recovery and boot registration are wired.

- [ ] **Step 3: Register boot work using `util/boot_init.ts`**

Register a named background task that checks Engine handshake, reads envelope versions, preserves `.previous` before migration, calls `migrate_snapshot` for older schemas, rejects newer schemas as degraded, replays pending evidence by stable ID, exports/verifies snapshot, then compacts the pending log. Register migration separately so a failed migration can surface `migration_failed` and does not look like an empty KSTAR state.

- [ ] **Step 4: Preserve ordinary product availability**

All Engine startup/tool/snapshot failures must be caught at the adapter boundary. Continue normal group chat, Agent, Wake and IPC boot; expose `kstar_status=degraded` and log only IDs/counts/status/error codes. Never write fake pass/fail, never drop raw evidence, and never use a total wall-clock timeout.

- [ ] **Step 5: Verify and commit recovery path**

Run:

```bash
npm exec vitest run test/main/features/p3394/kstar-recovery.test.ts test/main/features/p3394/kstar-migration.test.ts test/main/util/boot_init.test.ts
```

Expected: PASS for unavailable/recovery/newer-schema cases.

```bash
git add src/main/index.ts src/main/features/p3394/kstar-adapter.ts src/main/features/p3394/kstar-migration.ts src/main/features/p3394/kstar-store.ts test/main/features/p3394/kstar-recovery.test.ts test/main/features/p3394/kstar-migration.test.ts
git commit -m "feat: recover pending KSTAR evidence through boot initialization"
```

---

## Batch 3：删除旧实现与最终验证

### Task 14: 完成 Engine-only cutover 并删除旧 PC KSTAR 事实源

**Files:**
- Delete after all deletion gates pass: `src/main/features/p3394/kstar-runtime.ts`, `src/main/features/p3394/kstar-engine.ts`
- Delete or replace legacy-only tests: `test/main/features/p3394/kstar-runtime.test.ts`, `kstar-engine.test.ts`
- Modify: `src/main/features/p3394/index.ts`, `types.ts`, `kstar-kb.ts`, `kstar-notion.ts`, `group_chat/bus.ts`, all remaining imports found by static search
- Test: `test/static/kstar-single-core.test.ts`

- [ ] **Step 1: Add static deletion-proof tests before deleting files**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const p3394 = path.join(root, 'src/main/features/p3394');

describe('KSTAR has one semantic core', () => {
  it('does not retain the old PC fact model or local scoring', () => {
    expect(fs.existsSync(path.join(p3394, 'kstar-runtime.ts'))).toBe(false);
    const source = fs.readdirSync(p3394).filter(name => name.endsWith('.ts'))
      .map(name => fs.readFileSync(path.join(p3394, name), 'utf8')).join('\n');
    expect(source).not.toMatch(/delta_[ar]\s*[:=]/);
    expect(source).not.toMatch(/route_action|route_recommendation/);
    expect(source).not.toContain('userWorkSpace/meta-skill-engine-package');
  });
});
```

Also add a repository search assertion that every KSTAR mutation call is in `kstar-adapter.ts` or Engine package source, and that no runtime file imports `resources/builtin` or the old KSTAR types.

- [ ] **Step 2: Run static tests to identify remaining legacy references**

Run: `npm exec vitest run test/static/kstar-single-core.test.ts` and `rg -n "kstar-runtime|kstar-engine|KStarRun|delta_a|delta_r|route_recommendation|userWorkSpace/meta-skill-engine-package" src test scripts run.sh package.json`

Expected: static test/search reports only the intentionally pending deletion references and test fixture provenance fields.

- [ ] **Step 3: Replace every remaining production import with adapter/compat types**

Update `src/main/features/p3394/index.ts` exports, `types.ts` imports, Bus imports, KB/Notion imports, and IPC calls so new code references `KStarCompatRun`, `CompatExperienceCandidate`, `CompatPatchCandidate`, `KStarDecisionRecord` (Wake contract only), or adapter interfaces. Remove local `KStarRun`, `KStarEpisode`, `PatchCandidate`, `ExperienceCandidate` definitions from PC. Keep legacy JSON shape only inside migration/archive types and renderer compatibility DTOs.

- [ ] **Step 4: Delete old runtime and engine after the grep is clean**

Delete `kstar-runtime.ts` and `kstar-engine.ts`; replace their tests with Engine-backed adapter/contract tests. Do not delete KB/Notion files because they remain product integrations; they must contain no old source-of-truth lookup.

- [ ] **Step 5: Verify and commit the cutover**

Run:

```bash
npm exec vitest run test/static/kstar-single-core.test.ts test/main/features/p3394 test/main/features/group_chat/bus-integration.test.ts
rg -n "kstar-runtime|kstar-engine|KStarRun|delta_a|delta_r|route_recommendation|userWorkSpace/meta-skill-engine-package" src test scripts run.sh package.json
```

Expected: no production references to old runtime/engine or local Delta/route algorithms; only explicit migration fixture field names may remain under migration tests.

```bash
git add -A src/main/features/p3394 src/main/features/group_chat test/main/features/p3394 test/main/features/group_chat test/static
 git commit -m "refactor: remove legacy PC KSTAR core"
```

### Task 15: 完成 Engine-backed IPC/Renderer/packaged smoke 和全量测试

**Files:**
- Modify only if verification exposes a contract defect: `src/main/features/p3394/*`, `src/main/ipc/index.ts`, `src/renderer/modules/*`, `package.json`, packaging scripts
- Create: `test/e2e/p3394-engine-flow.test.ts` or use the repository's existing Electron smoke harness if it already supports the flow
- Create: `scripts/smoke-meta-skill-engine.mjs` only if the existing smoke runner cannot invoke the MCP process without adding a second production spawn path

- [ ] **Step 1: Add the real Electron flow test**

Exercise the approved success path with a test fixture: dispatch → Wake request → approve → Agent evidence → Commander terminal closure → Engine Episode → Engine proposal/experience projection. Assert the continuation token is consumed once, exactly one Episode is created, and the UI receives a compatibility DTO rather than opaque snapshot state.

```ts
expect(engineEpisodes).toHaveLength(1);
expect(projection.runs[0].id).toBe(engineEpisodes[0].legacy_projection_id);
expect(rendererPayload).not.toHaveProperty('state');
```

- [ ] **Step 2: Run targeted verification in the required order**

Run:

```bash
npm run engine:build
npm run engine:test
npm run engine:check
npm run typecheck
npm exec vitest run test/main/features/p3394 test/main/features/group_chat test/main/ipc/p3394-kstar-engine-routes.test.ts test/main/ipc/p3394-archive.test.ts test/renderer/p3394-experience-controls.test.ts test/renderer/conversation-info.test.ts test/static
```

Expected: all targeted tests PASS; no test may rely on `userWorkSpace/meta-skill-engine-package/dist`.

- [ ] **Step 3: Run required project verification**

Run:

```bash
npm test
npm run typecheck
npm run prepack
```

Expected: `npm test`, typecheck, and prepack all exit 0. If sqlite ABI switching is required, use the existing `npm test` script only; do not invoke `npx vitest` as the project-wide command.

- [ ] **Step 4: Run packaged MCP and platform checks**

Build the Electron package for the current host target, inspect the packaged archive/resources, and launch the packaged app with the MCP smoke. Verify:

- `packages/nseap-meta-skill-engine/dist/index.js` is present;
- ontology YAML is present;
- `get_engine_info` protocol major/capability/tools hash matches the PC adapter;
- no user workspace path is embedded as the runtime engine source;
- macOS and Windows path/command branches are tested with their existing platform test harnesses.

- [ ] **Step 5: Run final static audit and record evidence**

Run:

```bash
rg -n "delta_a|delta_r|route_recommendation|KStarRun|kstar-runtime|kstar-engine|userWorkSpace/meta-skill-engine-package" src/main src/renderer scripts run.sh package.json
rg -n "McpConnection|child_process|spawn\(" src/main/features/p3394 src/main/features/connectors
npm exec vitest run test/static/kstar-single-core.test.ts test/static/meta-skill-engine-packaging.test.ts
```

Expected: KSTAR semantic mutations are Engine-only; PC spawn remains limited to the existing MCP choke point; packaging contains the repository Engine. Save the command output and targeted test summary in the task report before claiming completion.

- [ ] **Step 6: Commit final verification-only corrections**

If and only if the verification commands identify a real contract defect, commit the minimal correction with its focused regression test:

```bash
git diff --name-only
git add -- path/from-the-focused-correction path/to-its-regression-test
git commit -m "test: close Meta Skill Engine migration verification gaps"
```

Do not amend earlier commits or include unrelated existing worktree changes.

---

## Verification checklist

The implementation is complete only when every item below has command/test evidence:

- [ ] Engine package is Git-tracked under `packages/nseap-meta-skill-engine/`; runtime does not read `userWorkSpace` or `resources/builtin`.
- [ ] Root `yaml@^2.6.1` dependency and lockfile are present.
- [ ] `--stdio` MCP process starts through existing `McpConnection`; no alternate PC spawn path exists.
- [ ] `get_engine_info` returns protocol/schema/version/tools hash/capabilities and adapter rejects incompatible handshakes.
- [ ] Engine owns snapshot generation; stale `base_generation` returns `E_SNAPSHOT_GENERATION_CONFLICT`.
- [ ] Snapshot import/export/validate/migrate round-trip works; newer schema is degraded and never overwritten.
- [ ] Pending evidence is append-only, folded by stable evidence ID, replayed idempotently, and compacted only after durable snapshot write.
- [ ] Per-user local paths and mutexes isolate users; archive and migration stamp remain local.
- [ ] Legacy migration imports only the high-confidence set as draft, archives the rest, writes hashes/counts, is idempotent, and renames the source only after atomic installation.
- [ ] Existing P3394 IPC names remain valid; archive IPC is read-only and excluded from active attention/metrics.
- [ ] Wake KSTAR metadata and workflow resume token survive approval/recovery unchanged.
- [ ] KB/Notion use Engine `experience_id`/`episode_id`/`bundle_id`/governance ID and do not duplicate Notion pages on retry.
- [ ] Engine unavailable state does not block chat/Agent/Wake and never fabricates KSTAR status.
- [ ] Renderer active cards remain compatible; history/degraded state is localized and archive has no mutation affordances.
- [ ] Static deletion proof confirms no PC Delta/attribution/patch-route algorithm or old KSTAR fact model remains.
- [ ] `npm test`, `npm run typecheck`, `npm run prepack`, Engine tests/check, packaged MCP smoke, and the real Electron flow pass.

## Spec coverage review

- Sections 1–2 (product decisions/non-goals): Tasks 1, 7, 10, 12, 14 preserve the boundary and explicitly defer retrieval-first/typed Delta/complete replay enhancements.
- Sections 3–4 (dual-core problem/selected architecture): Tasks 1, 7, 14 establish repository package, MCP process boundary, and deletion of the old core.
- Sections 5–7 (build/MCP/tool contract): Tasks 1–5 and 7 cover package/build, fixed stdio, `get_engine_info`, capabilities, tools hash, mutation CAS, and no filesystem root in Engine calls.
- Section 8 (persistence/CAS/pending/cloud IDs): Tasks 2, 6, 7, 10, and 13 cover opaque snapshots, `.previous`, uid mutex, append-only evidence, compact, and Engine identity.
- Section 9 (migration/archive/stamp/multi-machine): Task 4 and Task 9 cover Engine import, PC transaction, source hash, archive, retry, and cloud dedupe.
- Section 10 (IPC/archive): Task 11 covers existing routes, projection, archive APIs, and read-only constraints.
- Section 11 (Bus/Wake/closure): Task 8 covers normalized evidence, preserved Wake contract, and one terminal closure.
- Section 12 (degraded/recovery/versioning): Task 3, Task 7, and Task 13 cover unavailable Engine, pending replay, newer schema, and protocol incompatibility.
- Section 13 (Review Center/UI): Task 11 and Task 12 cover Engine status/proposal projection and history UI.
- Section 14 (security/data boundary): Tasks 1, 5, 6, 7, 13, and 14 enforce package/runtime/path/logging boundaries.
- Sections 15–19 (tests, batches, deletion gates, rollback, success): Tasks 1–15 and the verification checklist provide the test-first sequence and evidence gates.

## Next skill

`$superpower-subagents` (recommended) or `$superpower-executing-plans`
