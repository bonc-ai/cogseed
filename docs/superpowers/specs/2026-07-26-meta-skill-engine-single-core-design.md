# Meta Skill Engine 单一 KSTAR 核心迁移设计

**日期：** 2026-07-26
**状态：** 待用户复核
**目标：** 将现有 `userWorkSpace/meta-skill-engine-package/` 迁入主仓库并作为唯一 KSTAR 语义核心；删除 PC 侧旧 KSTAR 算法，同时保留 P3394 Wake/协议、现有 IPC 名称、Renderer、用户数据边界和产品集成能力。

## 1. 已确认的产品决策

1. Meta Skill Engine 迁入并由 Git 跟踪，随应用版本发布。
2. Meta Skill Engine 是唯一 KSTAR 核心和状态机定义者。
3. PC 只保留 MCP 适配、用户隔离存储、IPC 兼容、UI、Wake、KB/Notion 连接。
4. 本次先完成唯一核心迁移；retrieval-first、typed Delta、完整 replay/canary 在后续阶段增强。
5. 现有 IPC 名称保持不变，Renderer 基本不重写。
6. 旧数据采用“高可信选择性迁移 + 其余只读归档”。
7. 旧 PC KSTAR 运行时代码在迁移门槛满足后删除，不做长期双写或双读。

## 2. 非目标

本次不实现：

- 论文完整 Retrieval → Adapt → Coverage → Generate 控制循环；
- 统一 CognitiveAsset registry 的全部资产类型；
- typed Situation/Task 和 typed Delta 的最终版本；
- 完整 protected replay benchmark；
- 自动生产发布、跨设备联邦学习或共享 Registry；
- IPC namespace 从 `p3394.*` 重命名；
- Renderer 视觉重设计。

这些进入后续独立设计，避免与“删除双核心”耦合。

## 3. 当前问题

当前有两套 KSTAR 语义来源：

### 3.1 PC 旧实现

位于：

- `src/main/features/p3394/kstar-runtime.ts`
- `src/main/features/p3394/kstar-engine.ts`
- `src/main/features/p3394/kstar-kb.ts`
- `src/main/features/p3394/kstar-notion.ts`

它定义了自己的 Run、Episode、ExperienceCandidate、PatchCandidate、状态转换、Commander validation 和 KB promotion。

### 3.2 Meta Skill Engine 原型

当前位于未跟踪目录：

- `userWorkSpace/meta-skill-engine-package/`

它定义了：

- `KSTAREpisode`
- `EvidenceBundle`
- `InteractionContext`
- Ontology/Skill contract
- Attribution
- PatchProposal
- GovernanceFields
- GovernanceGates
- Registry/versioning

但当前存储主要是进程内数组/Map，PC 只调用 `capture_interaction → analyze_attribution → route_recommendation`，没有持久化和完整治理接入。

双核心导致：

- 类型重复；
- 状态含义漂移；
- Delta/归因重复实现；
- PC patch 类型与 Engine proposal 类型不一致；
- Engine 已有治理模块但产品绕过；
- 数据迁移与 UI 无明确事实源。

## 4. 方案选择

### 4.1 采用：仓库内置、MCP 隔离的核心包

新目录：

```text
packages/nseap-meta-skill-engine/
  package.json
  tsconfig.json
  src/
    index.ts
    types/
    modules/
    persistence/
    migration/
  ontologies/
  test/
```

包保持 ESM 和 MCP stdio server 形态。PC 不直接 import Engine 算法模块，而是通过现有 `McpConnection` 调用，保持产品层与算法核心的进程边界。

### 4.2 不采用：直接并入 `src/main/features/`

这会让 PC 再次拥有 Engine 内部类型和算法，违背单一核心目标。

### 4.3 不采用：继续依赖用户工作目录

这无法保证打包版、开源构建、其他机器和干净安装具有 KSTAR 核心。

## 5. 仓库与构建边界

### 5.1 源码归属

- Meta Skill Engine 源码、ontology、测试进入 `packages/nseap-meta-skill-engine/`。
- `userWorkSpace/meta-skill-engine-package/` 不再作为运行时来源。
- 用户工作目录中的副本不参与构建、测试或版本选择。

### 5.2 构建产物与 MCP 启动

开发和打包统一使用：

```text
packages/nseap-meta-skill-engine/dist/index.js
```

PC 不增加新的 spawn 特例。`kstar-adapter.ts` 必须复用 `features/connectors/mcp-client.ts` 的 `McpConnection`，由现有 MCP stdio choke point 启动：

```text
node packages/nseap-meta-skill-engine/dist/index.js --stdio
```

Engine 在没有 `--stdio` 时可以执行 CLI health/help，但产品运行时只允许 `--stdio` 模式。

Engine `package.json` 增加机器可读字段：

```json
{
  "kstar": {
    "protocolVersion": "1.0.0",
    "snapshotSchemaVersion": "1.0.0"
  }
}
```

运行时不直接信任 package.json；MCP `get_engine_info` 返回值才是握手事实源：

```text
engine_name
engine_version
protocol_version
snapshot_schema_version
tools_hash
capabilities:
  snapshot_import_export
  snapshot_migration
  legacy_pc_import
  compatibility_projection
  governance
```

PC 启动时比较协议 major version、所需 capability 和 tools hash；不兼容时进入 degraded，不尝试调用未知 mutation。

需要更新：

- `scripts/ensure-dev-dependencies.cjs`：检查并构建 Engine；
- `run.sh`：从仓库 package path 配置 KSTAR MCP；
- Electron packaging/files 配置：包含 `dist/`、ontology 和必要 manifest；
- smoke/preflight：检查 Engine 版本和 MCP tool contract。

### 5.3 依赖请求

Meta Skill Engine 当前需要：

- `@modelcontextprotocol/sdk`：主仓库已有；
- `zod`：主仓库已有；
- `yaml`：主仓库当前没有直接依赖。

**实施前需要用户明确批准新增主进程运行时依赖 `yaml`。** 推荐使用与原型一致的 `yaml@^2.6.1`，不复制第三方解析器源码。

## 6. 目标模块边界

### 6.1 Engine 唯一拥有

Meta Skill Engine 是以下对象和状态转换的唯一事实源：

- Episode；
- EvidenceBundle；
- AttributionRecord；
- PatchProposal；
- GovernanceDecision；
- RegistryEntry/version history；
- Engine validation/route/proposal 状态；
- Experience 是否具备推广价值；
- 后续 Delta 和 retrieval-first 算法。

PC 不允许重新计算：

- `delta_a` / `delta_r`；
- root cause；
- route recommendation；
- patch type/target；
- governance gate 结果；
- Engine 状态转换。

### 6.2 PC 保留

保留：

```text
src/main/features/p3394/protocol.ts
src/main/features/p3394/types.ts        # 仅 Wake/协议和兼容 DTO
src/main/features/p3394/wake-service.ts
src/main/features/p3394/wake-controller.ts
src/main/features/p3394/wake-store.ts
```

新增：

```text
src/main/features/p3394/kstar-adapter.ts
src/main/features/p3394/kstar-store.ts
src/main/features/p3394/kstar-compat.ts
src/main/features/p3394/kstar-migration.ts
```

职责：

- `kstar-adapter.ts`：MCP connection、tool 调用、超时、重试、degraded 状态；
- `kstar-store.ts`：按 uid 原子读写 Engine snapshot、pending evidence queue、archive；
- `kstar-compat.ts`：Engine schema → 旧 IPC DTO 的只读投影；
- `kstar-migration.ts`：一次性旧数据扫描、Engine migration tool 调用、归档和 stamp。

删除：

```text
src/main/features/p3394/kstar-runtime.ts
```

替换后删除或改名：

```text
src/main/features/p3394/kstar-engine.ts
src/main/features/p3394/kstar-kb.ts
src/main/features/p3394/kstar-notion.ts
```

KB/Notion 功能不能继续依赖旧 `KStarRun`，必须接收 Engine ID 和 Engine projection。

## 7. MCP 合同

### 7.1 保留的原型工具

- `capture_interaction`
- `analyze_attribution`
- `route_recommendation`
- ontology tools
- patch/governance tools
- registry tools

### 7.2 本次新增的系统集成工具

```text
get_engine_info
validate_snapshot
migrate_snapshot
import_snapshot
export_snapshot
record_evidence_bundle
list_episodes
get_episode
list_experience_candidates
review_experience_candidate
list_patch_proposals
review_patch_proposal
import_legacy_pc_kstar
project_compat_view
```

`get_engine_info` 合同：

```ts
{
  engine_name: string;
  engine_version: string;
  protocol_version: string;
  snapshot_schema_version: string;
  tools_hash: string;
  capabilities: string[];
}
```

约束：

- 所有 mutating tool 输入 `base_generation`，成功后由 Engine 将 generation 精确递增 1；
- mutation 返回完整 snapshot envelope、new generation 和 operation ids；
- base generation 不匹配返回 `E_SNAPSHOT_GENERATION_CONFLICT`，不得隐式合并；
- Engine tool 不接收真实文件系统根路径；
- PC 传入/取出对象，PC 负责保存；
- Engine 不直接读写 `<uid>` 用户目录；
- `project_compat_view` 是旧 IPC 兼容的统一来源，避免 PC 猜测状态含义。

## 8. 持久化设计

### 8.1 用户本机状态

```text
<uid>/local/kstar/
  engine.json                 # engine/schema/version/generation
  snapshot.json               # Engine opaque snapshot envelope
  pending-evidence.jsonl      # Engine 不可用时的 append-only evidence 状态事件
  migration.json              # migration version/status/counts/hash
  archives/
    legacy-pc-kstar-2026-07-26.json
```

Snapshot envelope 由 Engine 定义：

```ts
{
  engine_schema_version: string;
  engine_version: string;
  protocol_version: string;
  generation: number;
  kstar_timestamp: string;
  state: unknown;
  state_hash: string;
}
```

PC 视 `state` 为 Engine 拥有的 opaque object：

- 可以保存 envelope、校验 hash、做备份；
- 不能修改其中 Episode/Proposal/Governance 字段；
- 兼容投影必须通过 Engine tool 生成；
- generation 只由 Engine mutation 递增，PC 不自行生成。

### 8.2 并发与 generation CAS

- 每 uid 一个 KSTAR mutex；
- mutation 顺序：load envelope → `import_snapshot` → call mutating tool with `base_generation` → `export_snapshot` → verify generation/hash → atomic write；
- Engine mutation 必须返回 `generation = base_generation + 1`；
- PC 写入前再次确认磁盘 generation 等于 base generation；否则丢弃返回值并重试完整事务；
- `E_SNAPSHOT_GENERATION_CONFLICT` 不可通过 last-write-wins 处理；
- PC 崩溃时保留上一个完整 snapshot 和 `.previous` generation；
- 同一证据使用 stable evidence id，Engine import 必须幂等。

### 8.3 Pending evidence 日志

`pending-evidence.jsonl` 是 append-only 状态事件流，不原地更新已有行：

```jsonl
{"type":"pending","evidence_id":"ev-uuid","evidence":{},"created_at":"..."}
{"type":"imported","evidence_id":"ev-uuid","engine_episode_id":"ep-123","generation":43,"created_at":"..."}
{"type":"failed","evidence_id":"ev-uuid","retryable":true,"error_code":"...","created_at":"..."}
```

读取时按 `evidence_id` fold 最后状态：

1. scan JSONL；
2. 取最后状态为 pending 或 retryable failed 的记录；
3. 调用 Engine idempotent import；
4. snapshot 原子写成功后才 append imported 事件；
5. 如果 snapshot 写失败，不写 imported，允许安全重放。

Compact 规则：

- 在 uid mutex 下写临时文件并原子替换；
- 永久保留所有 unresolved evidence；
- 保留最近 500 条 imported/terminal failed 状态用于审计；
- 更旧的 imported 状态只保留 compact summary、count 和 hash；
- compact 不能改变 stable evidence id 或 Engine episode mapping。

### 8.3 云端经验

成功推广的经验继续写入：

```text
<uid>/cloud/contexts/kstar-experiences/<year>/<month>/<experience-id>.md
```

但推广资格、summary、source episode、governance status 必须来自 Engine。PC 只负责调用 `writeContextFileForUser` 和回写 promotion result。

KB 文档和 Notion payload 使用 Engine identity：

```yaml
experience_id: exp-123
source_episode_id: ep-xyz
source_bundle_id: bundle-xyz
governance_decision_id: decision-xyz
engine_version: 1.0.0
promoted_by: meta_skill_engine
source_legacy_run_id: legacy-run-abc   # optional，仅迁移对象存在
```

兼容规则：

- 旧 IPC `source_run_id` 优先返回 `source_legacy_run_id`，无 legacy 时返回 `source_episode_id`；
- 新内部代码禁止用 `source_run_id` 查询 Engine；
- KB/Notion 回写结果以 `experience_id` 和 `source_episode_id` 关联；
- Notion 重试不得创建同一 experience 的重复页面，使用 experience id 作为幂等键。

## 9. 数据迁移

### 9.1 迁移输入

旧文件：

```text
<uid>/local/p3394/kstar-state.json
```

当前实际数据基线：

- runs：24；
- 完整 KSTAR episode：5；
- incomplete runs：19；
- experience candidates：5（4 approved / 1 rejected）；
- patch candidates：5，全部是泛化 execution deviation；
- tool cycles：0；
- collaboration evidence：0。

### 9.2 高可信迁移

传给 Engine `import_legacy_pc_kstar`：

- 5 条具有 `kstar_episode` 的 run；
- 4 条 approved experience；
- 可验证的 evidence refs；
- 原始 source ids 和 timestamps。

Engine 生成：

- KSTAREpisode；
- EvidenceBundle；
- RegistryEntry；
- legacy provenance annotation。

固定治理标记：

```text
source_mode: real
authority_level: draft
non_claim_note: >
  Migrated from legacy PC KSTAR.
  Legacy Delta, attribution, review, and patch decisions are not trusted.
```

禁止迁移时：

- 直接信任旧 delta；
- 激活旧 patch；
- 把旧 approved 视为 released；
- 自动覆盖现有新 Engine 对象。

### 9.3 只读归档

以下全部进入 archive，不进入活跃 Registry：

- 19 条 incomplete run；
- 16 条旧 needs_review；
- 1 条 rejected experience；
- 5 条旧 PatchCandidate；
- 旧 verification/UI 状态；
- 无法关联的 evidence。

归档文件包含：

- 原始 JSON；
- archive schema/version；
- source file hash；
- migrated ids；
- rejected/archived reason；
- migration timestamp。

### 9.4 Migration stamp 与多机器语义

`<uid>/local/kstar/migration.json`：

```json
{
  "migration_version": 1,
  "status": "completed",
  "source_file": "local/p3394/kstar-state.json",
  "source_file_hash": "sha256:...",
  "archive_hash": "sha256:...",
  "snapshot_generation": 1,
  "engine_version": "1.0.0",
  "engine_schema_version": "1.0.0",
  "migrated_at": "2026-07-26T...",
  "counts": {
    "episodes_migrated": 5,
    "runs_archived": 19,
    "experiences_imported_as_draft": 4,
    "patches_archived": 5
  },
  "migrated_source_ids": [],
  "archived_source_ids": []
}
```

Idempotency：

- completed + source hash 匹配：返回 already_migrated；
- completed + source hash 不匹配：不自动重新导入，进入 `legacy_changed_after_migration` degraded 状态；
- failed/in_progress：从原文件和临时文件 hash 判断安全重试或回滚；
- Engine import 以 legacy source id 去重，重复 dry-run 不产生新 Episode。

KSTAR runtime state 是 local machine-private，不参与云同步，因此迁移 stamp 也是每台机器独立。若同一账号多台机器各自存在旧数据：

- 每台机器独立迁移自己的 legacy file；
- promoted cloud experience 使用 `source_episode_id + source_file_hash` 去重；
- 同一 legacy source 不因设备重复产生多个 cloud experience；
- 不使用 OAuth uid 推断数据内容相同。

### 9.5 原文件处置

迁移事务：

```text
1. read + hash legacy file
2. Engine dry-run import
3. validate counts and refs
4. write new snapshot to temp
5. write archive to temp
6. atomically install snapshot/archive/migration stamp
7. rename old file to kstar-state.legacy-2026-07-26.json
```

任何步骤失败：

- 不改原文件；
- 不写完成 stamp；
- 下次启动安全重试；
- UI 显示 migration_failed，不伪装为空状态。

## 10. IPC 兼容

保留现有名称：

```text
p3394.listKStarRuns
p3394.reviewKStarRun
p3394.listExperienceCandidates
p3394.decideExperienceCandidate
p3394.promoteExperienceCandidate
p3394.listPatchCandidates
p3394.reviewPatchCandidate
```

内部执行：

```text
IPC
→ kstar-compat / kstar-adapter
→ Engine MCP tool
→ Engine snapshot mutation/projection
→ old DTO response
```

兼容原则：

- old `run_id` 可以映射到 `episode_id`，但不得成为新事实源；
- old status 是 Engine governance status 的投影；
- Renderer 不直接收到 opaque snapshot；
- archive 不计入 active attention count；
- archive 只能通过新的 read-only history API 读取，不能 review/apply。

新增只读 IPC：

```text
p3394.listArchivedKStarRuns(cid?, cursor?, limit?)
p3394.getArchivedKStarRun(archiveId)
```

Archive 由 PC `kstar-store.ts` 读取，不导入 Engine active snapshot：

- list 只返回 id、legacy type/status、timestamp、conversation id 和截断 summary；
- detail 按 archive id 返回完整 legacy record；
- 不提供 review/apply/promote mutation；
- Renderer 放入单独“历史 KSTAR”section；
- archive 不计入 attention badge、active metrics 或 Engine benchmark。

## 11. Group Chat / Wake 数据流

### 11.1 Agent evidence

Commander 仍决定 `kstar: required|skip`，Bus Guard 可升级 durable result。

Agent 完成：

```text
Bus normalized evidence
→ pending evidence record
→ kstar-adapter.record_evidence_bundle
→ Engine mutation
→ export snapshot
```

PC 不创建自定义 `KStarRun`。

### 11.2 Wake

Wake request 必须持久化原始 KSTAR contract：

- required/skip；
- reason；
- expectation；
- source actor；
- workflow step/resume token。

审批恢复后原样传给 Engine evidence pipeline，不在 PC 重建 Episode。

### 11.3 Commander closure

协作真正终态时：

```text
Bus terminal signal
→ adapter.close_collaboration
→ Engine 聚合本次 pending evidence
→ Engine 生成最终 Episode/EvidenceBundle/Attribution
→ Engine 决定 experience/proposal/governance state
```

Commander 是产品层 evaluator/owner，但验证状态和对象由 Engine 生成。

## 12. Engine 不可用与恢复

### 12.1 Degraded 行为

Engine 启动、tool call 或 snapshot import 失败时：

- 普通聊天、Agent、Wake 继续工作；
- 不生成伪 KSTAR pass/fail；
- 原始证据 append 到 `pending-evidence.jsonl`；
- runtime status 暴露 `kstar_status=degraded`；
- Renderer 显示 KSTAR 暂不可用，不要求用户重做 Agent 任务；
- 日志只记录 id/count/status，原始内容不进入日志。

### 12.2 Snapshot 版本兼容

启动时先读取 envelope：

```text
engine_schema_version
engine_version
protocol_version
generation
```

处理规则：

- snapshot schema == current：validate/import；
- snapshot schema < current：调用 Engine `migrate_snapshot`，按连续版本 migration 链升级；
- migration 前保存 `.previous` 和原 hash；
- migration 后必须通过 `validate_snapshot`、generation 单调性和 object/ref count 检查；
- snapshot schema > current：进入 `snapshot_from_newer_engine` degraded，禁止 downgrade 写入；
- protocol major 不兼容：进入 `protocol_incompatible` degraded；
- 未知 migration path：保留旧 snapshot，只缓存 pending evidence，等待支持该版本的 Engine；
- PC 永远不能自行改写 Engine snapshot schema。

`migrate_snapshot` 返回：

```ts
{
  from_schema_version: string;
  to_schema_version: string;
  migrated_snapshot: SnapshotEnvelope;
  migration_steps: string[];
  warnings: string[];
}
```

### 12.3 恢复

恢复后：

```text
load last valid snapshot
→ replay pending evidence by stable evidence_id
→ Engine idempotent dedupe
→ export new snapshot
→ compact pending queue
```

同一 evidence 不得产生多个 Episode/Proposal。

## 13. Review Center 与 UI

Renderer 结构尽量保持：

- KSTAR status；
- experience controls；
- patch proposal review；
- attention-needed 汇总。

语义变化：

- 数据来自 Engine compatibility projection；
- Engine completed/rejected/staged 等状态是权威；
- 用户批准 patch 调用 Engine governance tool；
- PC 不直接修改 JSON 中的 status；
- legacy archive 在“历史 KSTAR”只读区域展示；
- 旧泛化 patch 不出现在待处理事项。

## 14. 安全与数据边界

- Engine process 不持有账户 secret；
- Engine 不接收容器根路径；
- PC adapter 在用户边界内读写 snapshot；
- MCP 请求中的用户内容不得进入普通日志；
- snapshot 和 pending evidence 是 local machine-private；
- promoted experience 经过现有 contexts writer 才进入 cloud；
- ontology 资源随应用发布，用户私有 ontology 引用通过 opaque ids 传入；
- archive 保持 local，不同步；
- Engine package 不从 `resources/builtin` 运行时路径读取。

## 15. 测试策略

### 15.1 Engine 包测试

- Episode/Evidence/Attribution/Patch/Governance contract；
- snapshot export/import round trip；
- generation conflict；
- idempotent evidence import；
- legacy dry-run/import；
- governance state machine；
- process restart persistence；
- invalid snapshot rejection；
- ontology resource loading。

### 15.2 PC adapter 测试

- MCP start/health/version；
- per-user isolation；
- atomic snapshot write；
- Engine unavailable → pending queue；
- recovery replay；
- no duplicate Episode；
- Wake KSTAR metadata preservation；
- no PC Delta/attribution calculation。

### 15.3 Migration fixtures

至少覆盖：

- 完整 legacy run；
- incomplete run；
- approved/rejected experience；
- generic patch；
- corrupted file；
- migration interrupted before rename；
- migration idempotency；
- already-migrated user；
- new user with no legacy file。

### 15.4 IPC/Renderer contract

现有 P3394 route tests 保留并改成 Engine-backed fixture：

- list/detail；
- experience decision/promotion；
- patch review；
- attention count；
- archived records read-only；
- degraded status。

### 15.5 删除证明

增加静态测试：

- `src/main/features/p3394/` 不再定义 `delta_a/delta_r` 算法；
- 不再存在旧 `KStarRun` 事实模型；
- PC 不再自行 route patch target；
- 所有 KSTAR mutation 必须经过 adapter；
- runtime 不引用 `userWorkSpace/meta-skill-engine-package`；
- packaged build 包含仓库 Engine dist/ontology。

## 16. 实施分批

### Batch 1a：前置依赖与 Engine 入库，不切流量

- 明确批准 `yaml@^2.6.1`；
- 复制并跟踪 package/ontology/tests；
- 统一 build/package scripts；
- 加 `--stdio`、`get_engine_info`、protocol/capability health；
- 加 snapshot envelope、generation、validate/import/export/migrate；
- package tests 和 packaged MCP smoke。

### Batch 1b：PC 基础适配与 shadow read

- 实现 kstar-store/adapter/compat；
- Engine snapshot persistence 和 pending evidence event log；
- IPC 从 Engine projection shadow read；
- 旧 runtime 仅作只读对照，不双写用户生产数据；
- old/new projection fixture diff；
- degraded/recovery tests。

### Batch 2：Migration 与 cutover

- 实现 kstar-migration 和 archive IPC；
- legacy import dry-run/fixtures；
- Wake metadata preservation；
- Engine 成为唯一 write path；
- Review Center/KB/Notion 切换到 Engine ids；
- 多机器/cloud experience dedupe。

### Batch 3：删除旧实现与最终验证

- 删除旧 runtime/engine types/algorithms；
- 删除旧 tests；
- 替换为 Engine contract tests；
- 静态搜索证明无旧事实源；
- 全量测试和真实 Electron QA。

## 17. 删除门槛

只有同时满足以下条件才能删除旧 PC KSTAR：

1. Engine package 已被 Git 跟踪并进入构建；
2. 打包后可启动 MCP，版本/工具合同匹配；
3. snapshot 重启持久化通过；
4. legacy migration dry-run 与真实 fixture 通过；
5. 旧 IPC contract 全部由 Engine projection 满足；
6. Wake KSTAR metadata 不丢失；
7. Review Center 可审核 Engine proposal；
8. KB/Notion 使用 Engine IDs；
9. degraded/recovery 不丢 evidence；
10. 静态测试确认 PC 不再计算 Delta/归因/patch route；
11. `npm test`、typecheck、packaging smoke 通过；
12. 真实 Electron 流程通过：dispatch → Wake → Agent → Commander closure → Engine episode → proposal/experience。

## 18. 回滚策略

切换前保留：

- legacy source file rename；
- new snapshot previous generation；
- migration manifest 和 hashes；
- release feature flag：只允许在迁移发布窗口内回退到 legacy read-only UI，不允许恢复 legacy writes。

如果新 Engine 不稳定：

- 停止新 KSTAR mutation；
- evidence 进入 pending queue；
- 不恢复旧算法；
- 修复 Engine 后 replay pending evidence。

原则是“回滚服务可用性，不回滚到双核心”。

## 19. 成功标准

迁移完成后：

- 仓库只有一套 KSTAR 核心类型和状态机；
- Meta Skill Engine 可独立测试、构建和通过 MCP 运行；
- PC KSTAR 文件只剩 adapter/store/compat/migration；
- 用户旧数据可追溯但不会污染活跃状态；
- 现有 Renderer/IPC 基本不变；
- KSTAR engine 重启后状态不丢；
- Engine 不可用时 Agent 协作不受阻且 evidence 不丢；
- 后续 retrieval-first 增强只修改 Engine 核心和明确的 adapter contract，不再新增第二套实现。

## 20. 最终批准项

实施前只剩一个需要明确批准的依赖项：

- 是否允许在根 `package.json` 新增 `yaml@^2.6.1` 作为 Meta Skill Engine ontology reader 的运行时依赖。

其余审计澄清项已经固化为实施约束：

- MCP 统一经现有 `McpConnection` stdio choke point；
- Engine 拥有 snapshot generation/schema migration；
- KB/Notion 以 Engine episode/bundle/experience id 为事实源；
- pending evidence 使用 append-only 状态事件与幂等 replay；
- archive 使用新增只读 IPC；
- migration stamp 按机器、uid 和 source hash 幂等；
- 新 Engine 不能读取较新 schema 时必须 degraded，不能降级覆盖。
