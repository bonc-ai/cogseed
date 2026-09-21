# Feature Specification: 记忆功能并入认知资产（统一管理）

**Feature Branch**: `认知资产迭代`
**Created**: 2026-09-19（回填 2026-09-20——实现先行，规格按 Spec Kit 规范补录）
**Status**: Implemented
**Input**: 用户需求原话：「功能上的全面合并，也就是认知资产会收编改造后的记忆功能」（2026-09-17 拍板，含方案甲：即时模式入库即可用带未验证标注）。

**Source**: design/认知资产统一终态图-20260917.html、goal-loop 账本第 1-37 轮（~/opensource/.goal-loop-ledger.md）、全链测试反推。

## 覆盖内容

记忆（USER.md/MEMORY.md 文件体系）整体并入认知资产：即时直投管线（模型当场记→查重金字塔→入库即用）、批量管线（复盘整理+KStar 沉淀同线）、画像注入换源（personal 资产）、存量迁移、记忆页退役。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 模型当场记的知识直接成为可用资产（即时直投）

**Independent Test**: 对话中模型沉淀一条知识 → 四态返回之一（created/merged/fused-update-pending/pending-review）；created 态资产 active 且带未验证标注、进目录可被引用。

**Acceptance Scenarios**:

1. **Given** 资产库无语义重复 **When** 即时直投 **Then** 新 personal 资产诞生（origin=会话线、未验证），回执与使用链全通。
2. **Given** 库内已有语义重复（≥0.85） **When** 直投 **Then** 融合进旧资产生成新版本，不产生第二条散资产。
3. **Given** embedding 不可用 **When** 自动晋升 **Then** 中止并留候选（`semantic_dedup_unavailable`），人工确认路径不受阻。

### User Story 2 - 查重融合金字塔与判族（合并成一条完整信息）

**Acceptance Scenarios**:

4. **Given** 新候选与库内资产相关 0.70-0.85 且质量差 ≥0.10 **When** 晋升 **Then** 并入旧资产生成待审新版本（L2）。
5. **Given** 两资产静态同键（ontologyRefs/KStar episode）或语义 ≥0.60 **When** 新资产入库 **Then** 自动挂 same_family 关系（直写 relations 不 bump 版本）。

### User Story 3 - 存量记忆迁移与旧链退役

**Acceptance Scenarios**:

6. **Given** USER.md 含 N 条旧记忆 **When** 迁移 **Then** 清零并入资产库（备份留存），画像注入改读 personal 资产。
7. **Given** 任何渲染入口 **When** 检索「已确认/模型记的」区分 **Then** 出身收敛后（见 006）单一确定态。

## Tasks（全部已实施，详见 goal-loop 账本 1-37 轮与分支提交 ffe93c4 前历史）

- [x] 即时直投四态管线 / [x] 查重金字塔 L0-L4 / [x] 判族引擎 / [x] 候选归一化 / [x] 存量迁移+备份 / [x] 画像注入换源 / [x] 记忆页退役+导出导入保留 / [x] B 默认关（目录排序替代）
