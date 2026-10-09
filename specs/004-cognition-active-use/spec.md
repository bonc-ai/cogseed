# Feature Specification: 认知资产用户主动使用与漏取审计

**Feature Branch**: `认知资产迭代`
**Created**: 2026-09-19（回填 2026-09-20）
**Status**: Implemented
**Input**: 用户反馈「使用部分仅模型自己引用感觉好像有些不完整」（2026-09-19，拍板五件：画像三小修+用户主动使用+漏取审计）。

**Source**: goal-loop 账本第 34-37 轮；上下文投影与回执流代码。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 用户把资产挂到当前对话（主动使用）

**Independent Test**: 资产详情页点「用到当前对话」→ 投影 confirmed（user_confirmed 授权）+ 卡片消息进会话 → 下一轮注入命中该资产。

**Acceptance Scenarios**:

1. **Given** 存在最近会话 **When** 点击挂载 **Then** ProjectionInput.explicitAssetIds 命中：绕语义门、过 active 硬门、钉在用版；会话 JSONL 出现投影卡。
2. **Given** 无任何会话 **When** 查看按钮 **Then** 禁用并提示先进行对话。

### User Story 2 - 相关而未被用的资产留痕（漏取审计）

**Acceptance Scenarios**:

3. **Given** 目录 ★ 标记 2 条、本轮实际使用 1 条 **When** 回合收尾 **Then** 差集写 omitted/catalog_hint 回执，时间线出现「相关而未被用」行。
4. **Given** taskText 路径 **When** 查相关度 **Then** 相关路径不落缓存（防跨轮串味）。

### User Story 3 - 画像注入排序（出身收敛后两档）

5. **Given** 72h 内新沉淀与高使用老资产并存 **When** 画像块构建 **Then** 新沉淀排前（两档：72h 内 > 其余；同档使用次数+新近）。

## Tasks（已实施）

- [x] explicitAssetIds 投影通道 / [x] attachToConversation IPC 组合 / [x] 详情页挂载按钮+lastConversationCid / [x] 漏取差集回执+时间线行 / [x] 画像两档排序（006 收敛后口径）
