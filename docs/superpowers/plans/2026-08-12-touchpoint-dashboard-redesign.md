# 飞书触点界面重设计与后端语义聚合 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「触点」tab 从组件级状态平铺（stepper + 双面板）重设计为「状态仪表 + 待办卡」，后端 `dashboard.get` 提供语义聚合层 `overall`，消除「全绿却未授权」矛盾，术语全白话。

**Architecture:** 后端在 `application/` 层新增纯函数 `deriveOverall(dashboard)` 产出 `overall`（status/chain/issues，三块同源，契约测试锁定不变量）；前端触点页渲染改为四区块（hero 状态徽标 / 链路状态图 / 待办卡 / 简报卡 + 高级设置手风琴），`touchpoint-settings-model.js` 改为 overall 优先、本地推导兜底；连接管理页飞书面板合并概念卡、其余平台不动。

**Tech Stack:** TypeScript (main) / 原生 JS (renderer, no bundler) / vitest（`npm test`）/ 原生 `<details>` 实现手风琴（零 JS）。

**Spec:** `docs/superpowers/specs/2026-08-12-touchpoint-dashboard-redesign-design.md`

## Global Constraints

- 渲染层为 vanilla JS + contextBridge（`window.orkas.invoke`），无 TS/JSX/bundler；IPC 失败返回 `{ ok: false, error }` 不 reject。
- 用户可见字符串必须走 i18n（`src/renderer/locales/{zh,en,pt,ja}.json` + `t()`），渲染函数内已有 `tr(key, fallback)` 帮助函数。
- **spec §5.1 微调（本计划已吸收）**：`issues[]` 改为 `{ severity, step, reason, actionId }`（后端只给状态枚举），`title/detail/action.label` 文案由前端 model 按 `step+reason+actionId` 映射 i18n key 生成——遵守 AGENTS.md「Visible UI strings go through locales」；术语快照测试改为断言前端映射表（见 Task 6）。
- `DashboardAction` union（`application/types.ts`）新增 `'connection.connect'` 与 `'authorization.reauth'`（扩展兼容，不破坏现有值）。
- 测试用 `npm test`（内部管理 sqlite ABI 交换），不直接跑 vitest。
- 只改飞书触点相关；telegram/wecom/wechat panel 的组装不动。
- 每次任务结束本地提交；最终重启客户端验证用 `scripts/restart-mate.sh`。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/main/features/personal_context/application/dashboard-model.ts` | 新建 | `deriveOverall(dashboard)` 纯函数：status/chain/issues 聚合 |
| `src/main/features/personal_context/application/types.ts` | 修改 | `DashboardOverall`/`ChainState`/`IssueReason` 类型 + `DashboardAction` 扩展 + `PersonalContextDashboard.overall` |
| `src/main/features/personal_context/application/service.ts` | 修改 | `demoDashboard()`/`buildRealDashboard()` 注入 `overall: deriveOverall(dashboard)` |
| `test/main/features/personal-context-dashboard-model.test.ts` | 新建 | deriveOverall 决策树全场景 + 不变量契约 |
| `src/renderer/modules/touchpoint-settings-model.js` | 修改 | overall 优先 + fallback；`buildIssueViewModel` 映射表；action 分发表导出（CommonJS bridge） |
| `test/main/features/touchpoint-settings-model.test.ts` | 修改 | 新增 overall 驱动/fallback/矛盾回归用例 |
| `src/renderer/modules/touchpoint-settings.js` | 修改 | 四区块新渲染；runAction 新动作；CommonJS bridge 导出 `ACTION_HANDLERS` |
| `src/renderer/locales/{zh,en}.json` | 修改 | 新增 chain/issue/advanced 键（pt/ja 跟随现有惯例复制 en） |
| `src/renderer/style.css` | 修改 | `touchpoint-chain*` / `touchpoint-issue*` / `touchpoint-accordion` 样式 |
| `src/renderer/modules/messaging-settings.js` | 修改 | 平台 soon 组一行灰字；飞书面板卡片合并 + 高级设置手风琴；断开连接文案 |
| `test/main/features/touchpoint-copy-contract.test.ts` | 新建 | 术语黑名单 + i18n key 存在性 + 动作映射全量 |

---

### Task 1: 后端聚合纯函数 `deriveOverall`

**Files:**
- Create: `src/main/features/personal_context/application/dashboard-model.ts`
- Modify: `src/main/features/personal_context/application/types.ts`
- Test: `test/main/features/personal-context-dashboard-model.test.ts`

**Interfaces:**
- Consumes: `PersonalContextDashboard`（`application/types.ts`，现有字段不变）
- Produces:
  - `type ChainState = 'ok' | 'missing' | 'broken'`
  - `type OverallStatus = 'ready' | 'attention' | 'off'`
  - `type IssueReason = 'not_configured' | 'token_expired' | 'sync_failed' | 'no_resources' | 'bot_error'`
  - `interface DashboardIssue { severity: 'error'|'warning'; step: 'connection'|'authorization'|'delivery'; reason: IssueReason; actionId: DashboardAction | null }`
  - `interface DashboardOverall { status: OverallStatus; chain: { connection: ChainState; authorization: ChainState; delivery: ChainState }; issues: DashboardIssue[] }`
  - `deriveOverall(dashboard: PersonalContextDashboard): DashboardOverall`

- [ ] **Step 1: 扩展 `DashboardAction` union 并新增类型**

在 `src/main/features/personal_context/application/types.ts`：

```ts
export type DashboardAction =
  | 'mode.demo.start'
  | 'mode.real.select'
  | 'connection.connect'          // 新增：触点页待办卡「连接机器人」
  | 'authorize.begin'
  | 'authorize.cancel'
  | 'authorize.revoke'
  | 'authorization.reauth'        // 新增：待办卡「重新授权」（前端映射到 authorize.begin 流程）
  | 'resources.discover'
  | 'resources.select'
  | 'sync.start'
  | 'sync.retry'
  | 'review.open'
  | 'briefing.preview'
  | 'briefing.test_delivery'
  | 'briefing.schedule'
  | 'briefing.pause';

// ── 语义聚合层（overall）─────────────────────────────
export type ChainState = 'ok' | 'missing' | 'broken';
export type OverallStatus = 'ready' | 'attention' | 'off';
export type IssueReason = 'not_configured' | 'token_expired' | 'sync_failed' | 'no_resources' | 'bot_error';

export interface DashboardIssue {
  severity: 'error' | 'warning';
  step: 'connection' | 'authorization' | 'delivery';
  reason: IssueReason;
  actionId: DashboardAction | null;
}

export interface DashboardOverall {
  status: OverallStatus;
  chain: { connection: ChainState; authorization: ChainState; delivery: ChainState };
  issues: DashboardIssue[];
}
```

并把 `PersonalContextDashboard` 增加字段：

```ts
export interface PersonalContextDashboard {
  mode: DashboardMode;
  messaging: MessagingConnectionSummary;
  authorization: AuthorizationSummary;
  resources: ResourceSummary;
  sync: SyncSummary;
  review: ReviewSummary;
  briefing: BriefingSummary;
  actions: DashboardAction[];
  overall: DashboardOverall;   // 新增：语义聚合层
}
```

- [ ] **Step 2: 写失败测试** — 新建 `test/main/features/personal-context-dashboard-model.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { deriveOverall } from '../../../src/main/features/personal_context/application/dashboard-model';
import type { PersonalContextDashboard } from '../../../src/main/features/personal_context/application/types';

function dashboard(overrides: Partial<PersonalContextDashboard> = {}): PersonalContextDashboard {
  return {
    mode: 'real',
    messaging: { instanceId: null, botConnected: false, ownerConfigured: false },
    authorization: { kind: 'ready_to_authorize', providerId: 'feishu' },
    resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
    sync: { state: 'idle', lastRunAt: null, nextRunAt: null, processed: 0, failed: 0 },
    review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 },
    briefing: { state: 'not_configured', destination: null, lastDelivery: null, pendingCandidateCount: 0 },
    actions: [],
    overall: { status: 'off', chain: { connection: 'missing', authorization: 'missing', delivery: 'missing' }, issues: [] },
    ...overrides,
  } as PersonalContextDashboard;
}

describe('deriveOverall', () => {
  it('never configured → off, 三环节 missing，一条连接待办', () => {
    const overall = deriveOverall(dashboard());
    expect(overall.status).toBe('off');
    expect(overall.chain).toEqual({ connection: 'missing', authorization: 'missing', delivery: 'missing' });
    expect(overall.issues).toEqual([
      { severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' },
    ]);
  });

  it('已连机器人未授权 → attention，授权待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
    }));
    expect(overall.status).toBe('attention');
    expect(overall.chain.connection).toBe('ok');
    expect(overall.chain.authorization).toBe('missing');
    expect(overall.issues[0]).toMatchObject({ step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' });
  });

  it('已连+已授权未选资源 → attention，选择资源待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
    }));
    expect(overall.status).toBe('attention');
    expect(overall.chain.delivery).toBe('missing');
    expect(overall.issues[0]).toMatchObject({ step: 'delivery', reason: 'no_resources', actionId: 'resources.discover' });
  });

  it('令牌过期 → authorization broken + 重新授权待办（error 级）', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'needs_reauth', providerId: 'feishu' },
    }));
    expect(overall.chain.authorization).toBe('broken');
    expect(overall.status).toBe('attention');
    expect(overall.issues).toContainEqual(
      { severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' },
    );
  });

  it('同步失败 → delivery broken + sync.retry 待办', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
      resources: { discovered: 2, selected: 2, ready: 1, failed: 1, unsupported: 0 },
      sync: { state: 'partial_failure', lastRunAt: '2026-08-12T00:00:00.000Z', nextRunAt: null, processed: 2, failed: 1 },
    }));
    expect(overall.chain.delivery).toBe('broken');
    expect(overall.issues).toContainEqual(
      { severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' },
    );
  });

  it('全部就绪 → ready 且无待办（不变量）', () => {
    const overall = deriveOverall(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '本人' },
      resources: { discovered: 2, selected: 2, ready: 2, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: '2026-08-12T00:00:00.000Z', nextRunAt: null, processed: 2, failed: 0 },
      briefing: { state: 'preview_ready', destination: { instanceId: 'feishu-1', configured: true, schedule: { hour: 8, minute: 0 } }, lastDelivery: null, pendingCandidateCount: 0 },
    }));
    expect(overall.status).toBe('ready');
    expect(overall.chain).toEqual({ connection: 'ok', authorization: 'ok', delivery: 'ok' });
    expect(overall.issues).toEqual([]);
  });

  it('不变量：ready ⇔ chain 全 ok ⇔ issues 空', () => {
    const fixture = dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' },
      resources: { discovered: 1, selected: 1, ready: 1, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: null, nextRunAt: null, processed: 1, failed: 0 },
    });
    const overall = deriveOverall(fixture);
    const allOk = Object.values(overall.chain).every((state) => state === 'ok');
    expect(overall.status === 'ready').toBe(allOk);
    expect(allOk).toBe(overall.issues.length === 0);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm test -- test/main/features/personal-context-dashboard-model.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `deriveOverall`** — 新建 `src/main/features/personal_context/application/dashboard-model.ts`：

```ts
/**
 * 语义聚合层：把组件级 dashboard（messaging/authorization/resources/sync/briefing）
 * 聚合成用户语义的整体状态（overall）。
 *
 * 设计稿：docs/superpowers/specs/2026-08-12-touchpoint-dashboard-redesign-design.md §5.2
 * 纯函数：输入 PersonalContextDashboard，输出 DashboardOverall；不读写业务数据。
 */
import type { DashboardIssue, DashboardOverall, PersonalContextDashboard } from './types';

/**
 * 连接环节：ok ⇔ 有已启用实例且归属已配置（botConnected 语义）；
 * broken = 有实例但未就绪；missing = 无实例。
 */
function chainConnection(dashboard: PersonalContextDashboard) {
  const { messaging } = dashboard;
  if (messaging.botConnected === true && messaging.ownerConfigured === true) return 'ok';
  return messaging.instanceId ? 'broken' : 'missing';
}

/**
 * 授权环节：ok = connected；broken = needs_reauth/revoked/error；
 * missing = 其余（disconnected/ready_to_authorize/authorizing——authorizing 由
 * 渲染层读组件字段特判"授权中"，不产生待办）。
 */
function chainAuthorization(dashboard: PersonalContextDashboard) {
  const kind = dashboard.authorization.kind;
  if (kind === 'connected') return 'ok';
  if (kind === 'needs_reauth' || kind === 'revoked' || kind === 'error') return 'broken';
  return 'missing';
}

/**
 * 投递环节：前置（连接+授权）未就绪或未选资源 → missing；
 * 同步失败 → broken；ready/awaiting_review → ok；其余（进行中）→ missing（渲染层特判）。
 */
function chainDelivery(dashboard: PersonalContextDashboard) {
  const { authorization, resources, sync } = dashboard;
  if (authorization.kind !== 'connected') return 'missing';
  if (resources.selected === 0) return 'missing';
  if (sync.state === 'failed' || sync.state === 'partial_failure') return 'broken';
  if (sync.state === 'ready' || sync.state === 'awaiting_review') return 'ok';
  return 'missing';
}

export function deriveOverall(dashboard: PersonalContextDashboard): DashboardOverall {
  const chain = {
    connection: chainConnection(dashboard),
    authorization: chainAuthorization(dashboard),
    delivery: chainDelivery(dashboard),
  };
  const issues: DashboardIssue[] = [];
  if (chain.connection === 'missing') {
    issues.push({ severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' });
  } else if (chain.connection === 'broken') {
    issues.push({ severity: 'error', step: 'connection', reason: 'bot_error', actionId: 'connection.connect' });
  }
  if (chain.authorization === 'broken') {
    issues.push({ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' });
  } else if (chain.authorization === 'missing' && chain.connection === 'ok') {
    issues.push({ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' });
  }
  if (chain.delivery === 'broken') {
    issues.push({ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' });
  } else if (chain.delivery === 'missing' && chain.authorization === 'ok') {
    const noResources = dashboard.resources.selected === 0;
    issues.push({
      severity: 'warning',
      step: 'delivery',
      reason: noResources ? 'no_resources' : 'not_configured',
      actionId: noResources ? 'resources.discover' : 'briefing.schedule',
    });
  }
  const allOk = chain.connection === 'ok' && chain.authorization === 'ok' && chain.delivery === 'ok';
  const allMissing = chain.connection === 'missing' && chain.authorization === 'missing' && chain.delivery === 'missing';
  return { status: allOk ? 'ready' : allMissing ? 'off' : 'attention', chain, issues };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- test/main/features/personal-context-dashboard-model.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 6: Commit**

```bash
git add src/main/features/personal_context/application/dashboard-model.ts src/main/features/personal_context/application/types.ts test/main/features/personal-context-dashboard-model.test.ts
git commit -m "feat: 后端语义聚合层 deriveOverall（status/chain/issues 单一事实源）"
```

---

### Task 2: service 注入 overall

**Files:**
- Modify: `src/main/features/personal_context/application/service.ts`
- Test: 复用 Task 1 测试文件追加 2 例

**Interfaces:**
- Consumes: `deriveOverall`（Task 1）
- Produces: `dashboard.overall` 恒非空（demo 与 real 两条路径）

- [ ] **Step 1: 写失败测试**（追加到 `test/main/features/personal-context-dashboard-model.test.ts`）：

```ts
import { demoDashboard } from '../../../src/main/features/personal_context/application/service';

describe('service overall injection', () => {
  it('demo dashboard 聚合为 ready 且无待办', () => {
    const overall = demoDashboard().overall;
    expect(overall.status).toBe('ready');
    expect(overall.issues).toEqual([]);
  });
});
```

> 注意：`demoDashboard` 需从 service.ts 导出（若当前未导出则 Step 3 一并导出；现有 service.ts 未导出 demoDashboard，仅内部使用——Step 3 加 `export`）。

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/main/features/personal-context-dashboard-model.test.ts`
Expected: FAIL（`demoDashboard` 未导出 / `overall` 未注入）

- [ ] **Step 3: 实现** — 修改 `src/main/features/personal_context/application/service.ts`：

顶部导入：

```ts
import { deriveOverall } from './dashboard-model';
```

`demoDashboard()` 改为导出并在返回对象加 overall（在 `actions` 行后）：

```ts
export function demoDashboard(): PersonalContextDashboard {
  const dashboard: PersonalContextDashboard = {
    mode: 'demo',
    messaging: { instanceId: 'demo-feishu', botConnected: true, ownerConfigured: true, ownerLabel: '演示用户' },
    authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '演示用户' },
    resources: { discovered: 4, selected: 3, ready: 3, failed: 0, unsupported: 0 },
    sync: { state: 'ready', lastRunAt: '2026-08-10T08:00:00.000Z', nextRunAt: null, processed: 4, failed: 0 },
    review: { pending: 2, confirmed: 2, rejected: 0, sourceInvalidated: 0 },
    briefing: { state: 'preview_ready', destination: null, lastDelivery: null, pendingCandidateCount: 2 },
    actions: ['mode.real.select', 'sync.start', 'review.open', 'briefing.preview'],
  };
  dashboard.overall = deriveOverall(dashboard);
  return dashboard;
}
```

`buildRealDashboard` 在 `dashboard.actions = actionsFor(...)` 之后、`return dashboard` 之前加：

```ts
  dashboard.overall = deriveOverall(dashboard);
```

（`const dashboard: PersonalContextDashboard = {...}` 的 `actions: []` 后不必预置 overall，types 不允许 undefined——改为在 return 前赋值，见上。若 TS 因 `overall` 必填报错，将对象字面量的 `actions: []` 后加 `overall: { status: 'off', chain: { connection: 'missing', authorization: 'missing', delivery: 'missing' }, issues: [] },` 占位，再在 return 前用 `deriveOverall` 覆盖。）

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- test/main/features/personal-context-dashboard-model.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 现有 personal-context 相关测试全部通过（`overall` 为增量字段，不破坏旧断言；`dashboard()` fixture 已带 overall 占位）

- [ ] **Step 6: Commit**

```bash
git add src/main/features/personal_context/application/service.ts test/main/features/personal-context-dashboard-model.test.ts
git commit -m "feat: dashboard.get 注入 overall 语义聚合块（demo+real 双路径）"
```

---

### Task 3: 前端 model 改造（overall 优先 + 矛盾回归）

**Files:**
- Modify: `src/renderer/modules/touchpoint-settings-model.js`
- Test: `test/main/features/touchpoint-settings-model.test.ts`

**Interfaces:**
- Consumes: `dashboard.overall`（Task 2 产出）；现有 `deriveTouchpointSettingsModel(dashboard, instances)` 签名不变
- Produces:
  - `model.overallStatus: 'ready'|'attention'|'off'`
  - `model.chain: { connection, authorization, delivery }`（每项 `{ state, inProgress? }`；`inProgress` = authorizing/syncing 特判）
  - `model.issues: Array<{ severity, step, reason, actionId, titleKey, detailKey, actionLabelKey }>`（文案 key 由映射表生成）
  - `model.authorizedLabel`：authorized 时 identityLabel 缺失回退「已连接账号」
  - 现有输出（status/primaryAction/briefingConfigured 等）保留（渲染层兼容过渡）

- [ ] **Step 1: 写失败测试** — 追加到 `test/main/features/touchpoint-settings-model.test.ts`：

```ts
  it('uses backend overall when present (ready + no issues)', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      overall: {
        status: 'ready',
        chain: { connection: 'ok', authorization: 'ok', delivery: 'ok' },
        issues: [],
      },
    }), []);
    expect(model.overallStatus).toBe('ready');
    expect(model.issues).toEqual([]);
    expect(model.chain.connection.state).toBe('ok');
  });

  it('renders issues as view models with i18n keys', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      overall: {
        status: 'attention',
        chain: { connection: 'ok', authorization: 'broken', delivery: 'missing' },
        issues: [{ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' }],
      },
    }), []);
    expect(model.issues[0]).toMatchObject({
      severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth',
    });
    expect(typeof model.issues[0].titleKey).toBe('string');
    expect(typeof model.issues[0].actionLabelKey).toBe('string');
  });

  it('falls back to local derivation when overall is absent (legacy fixtures)', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true, ownerLabel: '本人' },
      authorization: { kind: 'connected', providerId: 'feishu', identityLabel: '学生账号' },
      resources: { discovered: 8, selected: 4, ready: 4, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: '2026-08-10T12:00:00.000Z', nextRunAt: null, processed: 8, failed: 0 },
    }), []);
    expect(model.overallStatus).toBe('ready');
    expect(model.chain.connection.state).toBe('ok');
    expect(model.issues).toEqual([]);
  });

  it('regression: authorized with empty identityLabel shows 已连接账号, never 未授权', () => {
    const model = deriveTouchpointSettingsModel(dashboard({
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'connected', providerId: 'feishu' }, // 无 identityLabel
      resources: { discovered: 2, selected: 2, ready: 2, failed: 0, unsupported: 0 },
      sync: { state: 'ready', lastRunAt: null, nextRunAt: null, processed: 2, failed: 0 },
    }), []);
    expect(model.authorized).toBe(true);
    expect(model.authorizedLabel).toBe('已连接账号');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- test/main/features/touchpoint-settings-model.test.ts`
Expected: FAIL（`overallStatus`/`chain`/`issues`/`authorizedLabel` 未定义）

- [ ] **Step 3: 实现** — 重写 `src/renderer/modules/touchpoint-settings-model.js` 的 `deriveTouchpointSettingsModel` 核心（保留现有推导变量，新增 overall 分支；文件整体替换为下方结构）：

```js
(function touchpointSettingsModelModule(root) {
  'use strict';

  const STEP_ORDER = ['connection', 'authorization', 'resources', 'ready'];

  // 文案映射表：step+reason → i18n key（渲染层 t() 翻译）。
  // 术语黑名单测试（Task 6）断言这些 key 的译文不含 ou_/Card JSON/颗粒度/实例。
  const ISSUE_COPY = {
    'connection.not_configured': { titleKey: 'touchpoint_settings.issue.connection_not_configured.title', detailKey: 'touchpoint_settings.issue.connection_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.connection.connect' },
    'connection.bot_error': { titleKey: 'touchpoint_settings.issue.bot_error.title', detailKey: 'touchpoint_settings.issue.bot_error.detail', actionLabelKey: 'touchpoint_settings.action.connection.connect' },
    'authorization.token_expired': { titleKey: 'touchpoint_settings.issue.token_expired.title', detailKey: 'touchpoint_settings.issue.token_expired.detail', actionLabelKey: 'touchpoint_settings.action.authorization.reauth' },
    'authorization.not_configured': { titleKey: 'touchpoint_settings.issue.authorization_not_configured.title', detailKey: 'touchpoint_settings.issue.authorization_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.authorization.begin' },
    'delivery.sync_failed': { titleKey: 'touchpoint_settings.issue.sync_failed.title', detailKey: 'touchpoint_settings.issue.sync_failed.detail', actionLabelKey: 'touchpoint_settings.action.sync.retry' },
    'delivery.no_resources': { titleKey: 'touchpoint_settings.issue.no_resources.title', detailKey: 'touchpoint_settings.issue.no_resources.detail', actionLabelKey: 'touchpoint_settings.action.resources.discover' },
    'delivery.not_configured': { titleKey: 'touchpoint_settings.issue.delivery_not_configured.title', detailKey: 'touchpoint_settings.issue.delivery_not_configured.detail', actionLabelKey: 'touchpoint_settings.action.briefing.schedule' },
  };

  // ── 本地兜底推导（overall 缺失时，如旧数据/旧测试 fixture）──────────────
  function fallbackChain(dashboard, botConnected, authorized, hasResources, syncState) {
    const connection = !botConnected ? (dashboard.messaging && dashboard.messaging.instanceId ? 'broken' : 'missing') : 'ok';
    const authKind = dashboard.authorization && dashboard.authorization.kind;
    const authorization = !authorized
      ? (authKind === 'needs_reauth' || authKind === 'revoked' || authKind === 'error' ? 'broken' : 'missing')
      : 'ok';
    const delivery = !authorized || !hasResources
      ? 'missing'
      : (syncState === 'failed' || syncState === 'partial_failure' ? 'broken'
        : (syncState === 'ready' || syncState === 'awaiting_review' ? 'ok' : 'missing'));
    return { connection, authorization, delivery };
  }

  function fallbackOverall(dashboard, botConnected, authorized, hasResources, syncState) {
    const chain = fallbackChain(dashboard, botConnected, authorized, hasResources, syncState);
    const issues = [];
    if (chain.connection === 'missing') issues.push({ severity: 'warning', step: 'connection', reason: 'not_configured', actionId: 'connection.connect' });
    else if (chain.connection === 'broken') issues.push({ severity: 'error', step: 'connection', reason: 'bot_error', actionId: 'connection.connect' });
    if (chain.authorization === 'broken') issues.push({ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' });
    else if (chain.authorization === 'missing' && chain.connection === 'ok') issues.push({ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' });
    if (chain.delivery === 'broken') issues.push({ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' });
    else if (chain.delivery === 'missing' && chain.authorization === 'ok') {
      const noResources = !hasResources;
      issues.push({ severity: 'warning', step: 'delivery', reason: noResources ? 'no_resources' : 'not_configured', actionId: noResources ? 'resources.discover' : 'briefing.schedule' });
    }
    const allOk = chain.connection === 'ok' && chain.authorization === 'ok' && chain.delivery === 'ok';
    const allMissing = chain.connection === 'missing' && chain.authorization === 'missing' && chain.delivery === 'missing';
    return { status: allOk ? 'ready' : allMissing ? 'off' : 'attention', chain, issues };
  }

  function buildIssueViewModel(issue) {
    const copy = ISSUE_COPY[`${issue.step}.${issue.reason}`] || {
      titleKey: 'touchpoint_settings.issue.generic.title',
      detailKey: 'touchpoint_settings.issue.generic.detail',
      actionLabelKey: issue.actionId ? `touchpoint_settings.action.${issue.actionId}` : '',
    };
    return { ...issue, ...copy };
  }

  function deriveTouchpointSettingsModel(dashboard, instances) {
    const data = dashboard || {};
    const messaging = data.messaging || {};
    const authorization = data.authorization || {};
    const resources = data.resources || {};
    const sync = data.sync || {};
    const briefing = data.briefing || {};
    const botConnected = messaging.botConnected === true && messaging.ownerConfigured === true;
    const authorizing = authorization.kind === 'authorizing';
    const authorized = authorization.kind === 'connected';
    const hasResources = Number(resources.selected || 0) > 0;
    const ready = botConnected && authorized && hasResources && ['ready', 'awaiting_review'].includes(sync.state);
    const currentStep = !botConnected ? 'connection' : !authorized ? 'authorization' : !hasResources ? 'resources' : 'ready';
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    const steps = STEP_ORDER.map((id, index) => ({
      id,
      state: ready || index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'waiting',
    }));
    // overall：后端优先（Task 2 注入）；缺失时本地兜底（旧数据/测试 fixture）
    const overall = data.overall || fallbackOverall(data, botConnected, authorized, hasResources, sync.state);
    const syncInProgress = ['discovering', 'syncing', 'extracting'].includes(sync.state);
    const chain = {
      connection: { state: overall.chain.connection, inProgress: false },
      authorization: { state: overall.chain.authorization, inProgress: authorizing },
      delivery: { state: overall.chain.delivery, inProgress: syncInProgress },
    };
    const destination = briefing.destination || null;
    return {
      status: overall.status,                       // ready | attention | off（替换旧三态）
      overallStatus: overall.status,
      chain,
      issues: (overall.issues || []).map(buildIssueViewModel),
      currentStep,
      steps,                                        // 保留（旧渲染过渡期仍引用；Task 4 移除渲染引用后删除）
      primaryAction: !botConnected
        ? 'connection.connect'
        : authorizing
          ? 'authorize.cancel'
          : !authorized
            ? 'authorization.begin'
            : !hasResources
              ? 'resources.discover'
              : sync.state !== 'ready' && sync.state !== 'awaiting_review'
                ? 'sync.start'
                : 'briefing.preview',
      botConnected,
      authorizing,
      authorized,
      hasResources,
      ready,
      showMetrics: authorized && (Number(resources.discovered || 0) > 0 || hasResources),
      canConfigureDelivery: ready,
      identityLabel: authorization.identityLabel || messaging.ownerLabel || messaging.ownerMaskedId || '',
      // 矛盾修复：authorized 时 label 缺失回退「已连接账号」，绝不显示「未授权」
      authorizedLabel: authorized ? (authorization.identityLabel || '已连接账号') : '未授权',
      instanceCount: Array.isArray(instances)
        ? instances.filter((instance) => instance && instance.platform === 'feishu_lark' && instance.enabled === true).length
        : 0,
      syncMessage: typeof sync.message === 'string' && sync.message ? sync.message : '',
      briefingConfigured: Boolean(destination && destination.configured),
      briefingSchedule: destination && destination.configured && destination.schedule
        ? { hour: destination.schedule.hour, minute: destination.schedule.minute }
        : null,
    };
  }

  const api = Object.freeze({ deriveTouchpointSettingsModel });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TouchpointSettingsModel = api;
}(typeof window !== 'undefined' ? window : null));
```

> 注意：现有测试断言 `model.status` 为 `'not_connected'`/`'connected'`/`'ready'`——本任务将 `status` 改为 overall 三态后**旧断言会失败**。处理：旧断言同步更新为新三态（`not_connected`→`off`、`connected`→`attention`），见 Step 3 之后 Step 5 的说明。若想保留旧值兼容，则 `status` 保留旧推导、另加 `overallStatus`——本计划选择**直接替换**（渲染层 Task 4 同步更新，过渡期仅测试受影响）。

- [ ] **Step 4: 更新既有测试断言为新三态**

`test/main/features/touchpoint-settings-model.test.ts` 中：
- `expect(model.status).toBe('not_connected')` → `toBe('off')`
- `expect(model.status).toBe('connected')` → `toBe('attention')`（若有）
- 其余（primaryAction/currentStep/steps/identityLabel）不变。

- [ ] **Step 5: 运行确认通过**

Run: `npm test -- test/main/features/touchpoint-settings-model.test.ts`
Expected: PASS（原有 6+ 新 4 用例）

- [ ] **Step 6: Commit**

```bash
git add src/renderer/modules/touchpoint-settings-model.js test/main/features/touchpoint-settings-model.test.ts
git commit -m "feat: 触点 model overall 优先+本地兜底，authorizedLabel 矛盾回归修复"
```

---

### Task 4: 触点页四区块新渲染

**Files:**
- Modify: `src/renderer/modules/touchpoint-settings.js`
- Modify: `src/renderer/locales/zh.json` / `en.json`（pt/ja 复制 en 惯例）
- Modify: `src/renderer/style.css`

**Interfaces:**
- Consumes: `model.overallStatus/chain/issues/authorizedLabel`（Task 3）；`ACTION_HANDLERS`（本任务定义并导出）
- Produces:
  - 渲染结构：hero（状态徽标三态）→ 链路状态图 → 待办卡区 → 简报卡 → 高级设置手风琴（`<details>`）
  - `window.__touchpointActionHandlers`（CommonJS bridge）：`{ [actionId]: fn }` 供 Task 6 动作映射测试
  - 新 i18n 键：`touchpoint_settings.status.{ready,attention,off}`、`touchpoint_settings.chain.{connection,authorization,delivery}.*`、`touchpoint_settings.issue.*`、`touchpoint_settings.advanced.*`（`advanced.title/detail` 已存在）、`touchpoint_settings.disconnect.*`

- [ ] **Step 1: 写失败测试（i18n 键存在性）** — 新建 `test/main/features/touchpoint-copy-contract.test.ts`：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { deriveTouchpointSettingsModel } = require('../../../src/renderer/modules/touchpoint-settings-model.js');

const ZH = JSON.parse(readFileSync(new URL('../../../src/renderer/locales/zh.json', import.meta.url), 'utf-8'));
const EN = JSON.parse(readFileSync(new URL('../../../src/renderer/locales/en.json', import.meta.url), 'utf-8'));

function keyIn(locale: Record<string, unknown>, key: string): boolean {
  return key.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), locale) !== undefined;
}

describe('touchpoint copy contract', () => {
  it('every issue view model key exists in zh.json and en.json', () => {
    const model = deriveTouchpointSettingsModel({
      mode: 'real',
      messaging: { instanceId: 'feishu-1', botConnected: true, ownerConfigured: true },
      authorization: { kind: 'needs_reauth', providerId: 'feishu' },
      resources: { discovered: 0, selected: 0, ready: 0, failed: 0, unsupported: 0 },
      sync: { state: 'failed', lastRunAt: null, nextRunAt: null, processed: 0, failed: 1 },
      review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 },
      briefing: { state: 'not_configured', destination: null, lastDelivery: null, pendingCandidateCount: 0 },
      actions: [],
      overall: {
        status: 'attention',
        chain: { connection: 'ok', authorization: 'broken', delivery: 'broken' },
        issues: [
          { severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' },
          { severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' },
        ],
      },
    }, []);
    for (const issue of model.issues) {
      expect(keyIn(ZH, issue.titleKey), `${issue.titleKey} missing in zh.json`).toBe(true);
      expect(keyIn(EN, issue.titleKey), `${issue.titleKey} missing in en.json`).toBe(true);
      expect(keyIn(ZH, issue.detailKey)).toBe(true);
      expect(keyIn(EN, issue.detailKey)).toBe(true);
      if (issue.actionLabelKey) {
        expect(keyIn(ZH, issue.actionLabelKey)).toBe(true);
        expect(keyIn(EN, issue.actionLabelKey)).toBe(true);
      }
    }
  });

  it('all issue copy values are free of developer terms', () => {
    const BANNED = ['ou_', 'Card JSON', '颗粒度', '实例', '回调地址', 'redirect'];
    const walk = (obj: unknown, path: string): string[] => {
      const hits: string[] = [];
      if (typeof obj === 'string') {
        for (const word of BANNED) if (obj.includes(word)) hits.push(`${path}: ${obj}`);
      } else if (Array.isArray(obj)) {
        obj.forEach((item, i) => hits.push(...walk(item, `${path}[${i}]`)));
      } else if (obj && typeof obj === 'object') {
        Object.entries(obj as Record<string, unknown>).forEach(([k, v]) => hits.push(...walk(v, `${path}.${k}`)));
      }
      return hits;
    };
    const ts = (ZH as Record<string, unknown>).touchpoint_settings as Record<string, unknown>;
    const hits = walk(ts.issue ?? {}, 'touchpoint_settings.issue').concat(walk(ts.chain ?? {}, 'touchpoint_settings.chain'));
    expect(hits).toEqual([]);
  });
});
```

> 说明：Step 1 的测试依赖 Step 2 的 i18n 键与 model 实现，因此本任务采用「先渲染实现 + i18n 键，后补测试」顺序（TDD 对本任务按集成顺序：先写 i18n 键与渲染，再写测试锁定）。本 Step 的测试文件在 Step 4 后运行。

- [ ] **Step 2: i18n 键** — 在 `src/renderer/locales/zh.json` 的 `touchpoint_settings` 段新增（en.json 同步英文）：

```jsonc
// zh.json touchpoint_settings 段新增：
"status": {
  "ready": "可正常使用",
  "attention": "需要处理",
  "off": "未连接"
},
"chain": {
  "connection": { "ok": "你的飞书账号", "missing": "尚未连接", "broken": "连接异常" },
  "authorization": { "ok": "日历与资料", "missing": "未允许读取", "broken": "读取已失效" },
  "delivery": { "ok": "每日简报", "missing": "未设置简报", "broken": "简报不可用" },
  "in_progress": "处理中…"
},
"issue": {
  "generic": { "title": "需要处理", "detail": "请完成提示的操作后重试。" },
  "connection_not_configured": { "title": "连接一个飞书机器人", "detail": "连接后，Mate 才能在你离开电脑时联系你。" },
  "bot_error": { "title": "飞书连接异常", "detail": "机器人连接出现问题，请重新连接。" },
  "token_expired": { "title": "授权已过期", "detail": "重新授权即可恢复日历和资料的读取。" },
  "authorization_not_configured": { "title": "允许 Mate 读取你的日历和资料", "detail": "只读取你明确选择的内容，默认只读。" },
  "sync_failed": { "title": "部分内容同步失败", "detail": "Mate 会自动重试，你也可以手动重新同步。" },
  "no_resources": { "title": "选择允许读取的内容", "detail": "勾选后，Mate 才会把这些内容用于为你服务。" },
  "delivery_not_configured": { "title": "设置每日简报", "detail": "设置后，每天定时收到你的日程汇总。" }
},
"action": {
  "authorization.reauth": "重新授权",
  "sync.retry": "重新同步"
},
"disconnect": {
  "title": "断开连接",
  "detail": "断开后 Mate 将无法通过飞书联系你，日历和资料的读取也会停止。已保存的数据不会被删除。",
  "confirm": "确定要断开飞书连接吗？断开后需要重新扫码绑定才能恢复。"
},
"advanced": {
  "title": "高级设置",
  "detail": "消息样式、工作区范围与连接管理"
}
```

> 注意：`touchpoint_settings.status` 现有值为 `not_connected/connected/ready`（`statusText(value)` 使用）——**替换**为三态并同步修改 `touchpoint-settings.js` 的 `statusText` 调用（Task 4 Step 3 处理）。`action` 段现有 `connection.manage` 等保留。

- [ ] **Step 3: 渲染实现** — 修改 `src/renderer/modules/touchpoint-settings.js`：

3a. `render()` 新结构（替换 `renderSteps`/`renderConnectionCard`/`renderAccessCard` 调用区）：

```js
  function renderChainView(view) {
    const order = [
      ['connection', view.chain.connection],
      ['authorization', view.chain.authorization],
      ['delivery', view.chain.delivery],
    ];
    return `<section class="touchpoint-chain">${order.map(([step, node]) => `
      <div class="touchpoint-chain-node is-${escape(node.state)}${node.inProgress ? ' is-progress' : ''}">
        <span class="touchpoint-chain-dot"></span>
        <div class="touchpoint-chain-label"><strong>${escape(tr(`touchpoint_settings.chain.${step}.${node.inProgress ? 'ok' : node.state}`, ''))}</strong>${node.inProgress ? `<small>${escape(tr('touchpoint_settings.chain.in_progress', ''))}</small>` : ''}</div>
      </div>`).join('<span class="touchpoint-chain-arrow">→</span>')}</section>`;
  }

  function renderIssueCards(view) {
    if (!view.issues || view.issues.length === 0) return '';
    return `<section class="touchpoint-issues">${view.issues.map((issue) => `
      <article class="touchpoint-issue-card is-${escape(issue.severity)}">
        <span class="touchpoint-issue-glyph">${iconMarkup(issue.severity === 'error' ? 'alert-circle' : 'clock', 'touchpoint-issue-icon')}</span>
        <div class="touchpoint-issue-body">
          <h3>${escape(tr(issue.titleKey, issue.titleKey))}</h3>
          <p>${escape(tr(issue.detailKey, issue.detailKey))}</p>
        </div>
        ${issue.actionId ? `<button class="btn btn-primary touchpoint-issue-action" data-touchpoint-action="${escape(issue.actionId)}" ${state.busy ? 'disabled' : ''}>${escape(tr(issue.actionLabelKey, issue.actionLabelKey))}</button>` : ''}
      </article>`).join('')}</section>`;
  }

  function renderAdvancedSettings(view) {
    return `<section class="touchpoint-advanced">
      <details class="touchpoint-accordion">
        <summary><span>${escape(tr('touchpoint_settings.advanced.title', '高级设置'))}</span><small>${escape(tr('touchpoint_settings.advanced.detail', ''))}</small></summary>
        <div class="touchpoint-advanced-body">
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.account', '你的飞书账号'))}</span><strong>${escape(view.authorizedLabel)}</strong></div>
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.style', '消息样式'))}</span><button class="btn touchpoint-secondary" data-touchpoint-action="advanced.response">${escape(tr('touchpoint_settings.advanced.style_edit', '修改'))}</button></div>
          <div class="touchpoint-advanced-row"><span>${escape(tr('touchpoint_settings.advanced.workspace', '工作区范围'))}</span><button class="btn touchpoint-secondary" data-touchpoint-action="advanced.workspace">${escape(tr('touchpoint_settings.advanced.workspace_edit', '修改'))}</button></div>
          <div class="touchpoint-advanced-actions">
            <button class="btn touchpoint-secondary" data-touchpoint-action="authorization.revoke">${escape(tr('touchpoint_settings.advanced.stop_reading', '停止读取数据'))}</button>
            <button class="btn btn-danger" data-touchpoint-action="disconnect">${escape(tr('touchpoint_settings.disconnect.title', '断开连接'))}</button>
          </div>
        </div>
      </details>
    </section>`;
  }
```

3b. 新的 `render()` 主函数（替换原 `renderSteps(view) + next 卡 + overview 双面板` 区段）：

```js
    host.innerHTML = `<div class="touchpoint-settings"><header class="touchpoint-hero"><div><h1>${escape(tr('touchpoint_settings.title', '飞书移动触点'))}</h1><p>${escape(tr('touchpoint_settings.subtitle', ''))}</p></div><div class="touchpoint-hero-actions"><span class="touchpoint-status is-${escape(view.overallStatus)}"><span></span>${escape(tr(`touchpoint_settings.status.${view.overallStatus}`, view.overallStatus))}</span><button class="btn touchpoint-icon-button" data-touchpoint-action="refresh" aria-label="${escape(tr('touchpoint_settings.refresh', '刷新'))}">${iconMarkup('refresh', 'touchpoint-refresh-icon')}</button></div></header>${renderChainView(view)}${renderIssueCards(view)}${view.ready ? renderDelivery(view) : ''}${renderAdvancedSettings(view)}${renderSetupGuideCard()}${state.notice ? `<div class="messaging-notice is-${escape(state.notice.kind)}">${escape(state.notice.text)}</div>` : ''}</div>`;
```

> 移除：`renderSteps`、`renderConnectionCard`、`renderAccessCard` 的调用与函数体（函数可删除，`view.steps` 同步从 model 输出删除——见 Task 3 的 steps 保留说明，Task 4 后 model 的 `steps/currentStep` 可删除；若删除则同步更新 model 测试中 steps 断言）。

3c. `runAction` 新增动作分支（在 `setup_guide.open` 分支后）：

```js
        else if (action === 'authorization.reauth') {
          // 重新授权 = 重新走授权流程（凭据未变，回调地址若已配置过不再拦截）
          await invoke('personal_context.authorize.begin', { instanceId: state.dashboard?.messaging?.instanceId || undefined });
        } else if (action === 'advanced.response' || action === 'advanced.workspace') {
          await showConnections({ startFeishuQr: false });
        } else if (action === 'disconnect') {
          const confirmed = typeof window.confirm === 'function'
            && window.confirm(tr('touchpoint_settings.disconnect.confirm', '确定要断开飞书连接吗？'));
          if (!confirmed) return;
          // 先撤数据授权，再删实例（revoke 依赖凭据，实例删除后凭据不可用）
          await invoke('personal_context.authorize.revoke', {}).catch(() => undefined);
          const instanceId = state.dashboard?.messaging?.instanceId;
          if (instanceId) {
            const result = await invoke('messaging.delete', { instanceId });
            if (result && result.deleted === false) throw new Error(result.error || '断开连接失败');
          }
          state.notice = { kind: 'success', text: tr('touchpoint_settings.disconnect.done', '已断开飞书连接。') };
        }
```

3d. 动作分发表导出（CommonJS bridge，供 Task 6 测试）：

```js
  // 动作分发表：model 产出的 actionId 必须在此注册（Task 6 全量映射测试强制）。
  const ACTION_HANDLERS = Object.freeze({
    refresh: 'refresh',
    'connections.back': 'connections.back',
    'connection.manage': 'connection.manage',
    'connection.connect': 'connection.connect',
    'authorization.begin': 'authorization.begin',
    'authorization.reauth': 'authorization.reauth',
    'authorization.cancel': 'authorization.cancel',
    'authorization.revoke': 'authorization.revoke',
    'resources.discover': 'resources.discover',
    'resources.save': 'resources.save',
    'sync.start': 'sync.start',
    'briefing.preview': 'briefing.preview',
    'briefing.test': 'briefing.test',
    'briefing.schedule': 'briefing.schedule',
    'briefing.unschedule': 'briefing.unschedule',
    'setup_guide.copy': 'setup_guide.copy',
    'setup_guide.open': 'setup_guide.open',
    'setup_guide.done': 'setup_guide.done',
    'advanced.response': 'advanced.response',
    'advanced.workspace': 'advanced.workspace',
    'disconnect': 'disconnect',
    'review.open': 'review.open',
  });
  // ... 文件末尾：
  if (typeof module !== 'undefined' && module.exports) module.exports = { ACTION_HANDLERS };
```

> `ACTION_HANDLERS` 的 value 是标记字符串（映射表用途），`runAction` 的既有 if-else 链保持不变（新增分支已加）；Task 6 测试断言 model 全部 actionId ⊆ ACTION_HANDLERS keys。

3e. `statusText` 删除或保留——三态直接 `tr()`，删除 `statusText` 函数与其 `touchpoint_settings.status.{not_connected,connected}` 旧键（zh/en 中移除旧三态键，保留 `ready` 改新义）。

- [ ] **Step 4: CSS** — `src/renderer/style.css` 追加（尾部）：

```css
/* ── 触点链路状态图 ── */
.touchpoint-chain { display: flex; align-items: stretch; gap: 8px; margin: 16px 0; }
.touchpoint-chain-node { flex: 1; display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--border-color, #ddd); border-radius: 10px; background: var(--surface-color, #fff); }
.touchpoint-chain-node .touchpoint-chain-dot { width: 10px; height: 10px; border-radius: 50%; background: #aaa; flex: none; }
.touchpoint-chain-node.is-ok .touchpoint-chain-dot { background: #34a853; }
.touchpoint-chain-node.is-broken { border-color: #ea4335; }
.touchpoint-chain-node.is-broken .touchpoint-chain-dot { background: #ea4335; }
.touchpoint-chain-node.is-missing { opacity: .75; }
.touchpoint-chain-node.is-progress .touchpoint-chain-dot { background: #fbbc04; animation: touchpoint-pulse 1.2s infinite; }
.touchpoint-chain-label strong { display: block; font-size: 13px; }
.touchpoint-chain-label small { color: #888; font-size: 11px; }
.touchpoint-chain-arrow { align-self: center; color: #999; }
@keyframes touchpoint-pulse { 50% { opacity: .4; } }

/* ── 待办卡 ── */
.touchpoint-issues { display: grid; gap: 10px; margin: 16px 0; }
.touchpoint-issue-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--border-color, #ddd); border-radius: 10px; background: var(--surface-color, #fff); }
.touchpoint-issue-card.is-error { border-color: #f5c6cb; background: #fef6f6; }
.touchpoint-issue-card.is-warning { border-color: #ffe3a3; background: #fffaf0; }
.touchpoint-issue-body { flex: 1; }
.touchpoint-issue-body h3 { margin: 0 0 2px; font-size: 14px; }
.touchpoint-issue-body p { margin: 0; color: #666; font-size: 12px; }
.touchpoint-issue-action { flex: none; }

/* ── 高级设置手风琴 ── */
.touchpoint-accordion summary { cursor: pointer; padding: 12px 14px; border: 1px solid var(--border-color, #ddd); border-radius: 10px; background: var(--surface-color, #fff); list-style: none; display: flex; justify-content: space-between; align-items: baseline; }
.touchpoint-accordion summary::-webkit-details-marker { display: none; }
.touchpoint-accordion summary small { color: #888; }
.touchpoint-accordion[open] summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.touchpoint-advanced-body { border: 1px solid var(--border-color, #ddd); border-top: none; border-radius: 0 0 10px 10px; padding: 12px 14px; display: grid; gap: 10px; }
.touchpoint-advanced-row { display: flex; justify-content: space-between; align-items: center; }
.touchpoint-advanced-actions { display: flex; gap: 10px; margin-top: 6px; }
```

- [ ] **Step 5: 运行测试**

Run: `npm test -- test/main/features/touchpoint-copy-contract.test.ts test/main/features/touchpoint-settings-model.test.ts`
Expected: PASS（i18n 键存在性 + 术语黑名单 + model 全量）

> 若 `touchpoint_settings.status.ready` 与 model 测试互冲（旧键删除影响 `statusText`），以三态为准同步修正。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/modules/touchpoint-settings.js src/renderer/locales/zh.json src/renderer/locales/en.json src/renderer/style.css test/main/features/touchpoint-copy-contract.test.ts
git commit -m "feat: 触点页四区块新渲染（链路状态图/待办卡/简报/高级手风琴）+ 断开连接组合动作"
```

---

### Task 5: 连接管理页瘦身

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/locales/zh.json` / `en.json`

**Interfaces:**
- Consumes: 现有 `CHANNELS`/`associationCard`/`ownerIdentityCard`/`preferencesCard`/`deleteInstance`（全部已有）
- Produces: 平台 soon 组一行灰字；飞书面板「你的飞书账号」合并卡 + 高级手风琴；断开连接文案增强

- [ ] **Step 1: soon 组一行灰字** — `renderMenuPage()`（`src/renderer/modules/messaging-settings.js:1661-1692`）中，将 `group === 'soon'` 的循环改为：

```js
    for (const group of ['open', 'soon']) {
      const section = el('div', `messaging-menu-group is-${group}`);
      section.appendChild(el('div', 'messaging-menu-group-label', labelFor(
        group === 'open' ? 'messaging.group.open' : 'messaging.group.soon', '',
      )));
      const channels = CHANNELS.filter((item) => item.group === group);
      if (group === 'soon') {
        // 未实现的平台收成一行灰字，不再占菜单位（设计稿 §4.1）
        const hint = el('div', 'messaging-menu-soon-hint', labelFor('messaging.group.soon_hint', ''));
        section.appendChild(hint);
        aside.appendChild(section);
        continue;
      }
      for (const channel of channels) {
        /* 现有 open 组渲染逻辑不变 */
      }
      aside.appendChild(section);
    }
```

i18n 新增（zh/en）：`messaging.group.soon_hint` = 「QQ、钉钉、Discord 即将支持」。

- [ ] **Step 2: 飞书面板卡片合并** — `renderFeishuPanel`（`messaging-settings.js:762-811`）中，把 `associationCard(instance)` 与 `ownerIdentityCard(instance)` 两次 append 合并为一次：

```js
    if (instance) {
      wrapper.appendChild(identityCard(instance));     // 合并后的「你的飞书账号」卡
      wrapper.appendChild(advancedCard(instance));     // 高级设置手风琴（含 responseSelect/workspaceSelect）
      wrapper.appendChild(deleteCard(instance));       // 断开连接卡（文案增强）
    }
```

新增两个私有函数（放在 `renderFeishuPanel` 附近）：

```js
  // 「你的飞书账号」：合并原关联机器人与归属两张卡，只显示昵称/遮罩 ID，不显示原始 ID
  function identityCard(instance) {
    const ownerName = instance.ownerLabel || instance.ownerMaskedId || labelFor('messaging.owner_unknown', '');
    const card = card('messaging.identity_title', 'messaging.identity_subtitle', 'messaging-identity-card');
    const row = el('div', 'messaging-identity-row');
    row.appendChild(el('span', 'messaging-identity-name', ownerName));
    row.appendChild(el('span', 'messaging-identity-badge is-bound', labelFor('messaging.status.bound', '')));
    card.appendChild(row);
    return card;
  }

  // 高级设置手风琴：消息样式 + 工作区范围（原 preferencesCard 折叠）
  function advancedCard(instance) {
    const details = el('details', 'messaging-accordion');
    const summary = el('summary', '', labelFor('messaging.advanced_title', ''));
    details.appendChild(summary);
    const body = el('div', 'messaging-advanced-body');
    const responseSelect = selectControl([
      { value: 'text', label: labelFor('messaging.response_text', '') },
      { value: 'streaming_card', label: labelFor('messaging.response_streaming_card', '') },
    ], instance.responseMode || 'text', state.updating);
    responseSelect.setAttribute('aria-label', labelFor('messaging.response_title', ''));
    responseSelect.addEventListener('change', () => {
      if (responseSelect.value !== (instance.responseMode || 'text')) {
        void updateInstance({ responseMode: responseSelect.value }, responseSelect);
      }
    });
    const workspaceSelect = selectControl([
      { value: 'all', label: labelFor('messaging.workspace_all', '') },
    ], 'all', state.updating);
    workspaceSelect.setAttribute('aria-label', labelFor('messaging.workspace_title', ''));
    workspaceSelect.addEventListener('change', () => {
      void updateInstance({ workspace: { type: 'all' } }, workspaceSelect);
    });
    body.appendChild(selectRow(labelFor('messaging.response_title', ''), responseSelect));
    body.appendChild(selectRow(labelFor('messaging.workspace_title', ''), workspaceSelect));
    details.appendChild(body);
    return details;
  }

  function selectRow(labelText, control) {
    const row = el('div', 'messaging-advanced-row');
    row.appendChild(el('span', '', labelText));
    row.appendChild(control);
    return row;
  }
```

> `associationCard`/`ownerIdentityCard`/`preferencesCard` 若不再被其他平台 panel 使用，删除函数体；若 telegram/wecom/wechat panel 仍引用（`grep -n "associationCard\|ownerIdentityCard\|preferencesCard"` 确认），保留函数但仅飞书面板不再调用。

- [ ] **Step 3: 断开连接文案** — `deleteInstance`（`messaging-settings.js:1555`）的 confirm 文案键 `messaging.delete_confirm` 增强为：zh = 「确定要断开连接吗？断开后 Mate 将无法通过该平台联系你。此操作不会删除已保存的数据。」

- [ ] **Step 4: i18n 键** — zh/en 新增：`messaging.group.soon_hint`、`messaging.identity_title`（你的飞书账号）、`messaging.identity_subtitle`（机器人和你的身份均已连接）、`messaging.owner_unknown`（未命名账号）、`messaging.advanced_title`（高级设置）；`messaging.delete_title/delete_subtitle/delete_confirm` 文案按设计更新（「断开连接」语义）。

- [ ] **Step 5: 运行测试**

Run: `npm test`
Expected: 全量通过（messaging-settings 为 DOM 模块无直接单测，回归由其余测试保障）

- [ ] **Step 6: 重启验证**

Run: `scripts/restart-mate.sh`，确认 `~/.orkas/runtime-variants/messaging/data/logs/<date>.log` 正常启动，打开「设置 → 消息平台」目测：soon 组一行灰字、飞书详情卡合并、高级手风琴可折叠、删除确认文案。

- [ ] **Step 7: Commit**

```bash
git add src/renderer/modules/messaging-settings.js src/renderer/locales/zh.json src/renderer/locales/en.json
git commit -m "feat: 连接管理页瘦身——平台 soon 组一行灰字、飞书账号卡合并、高级设置手风琴、断开连接文案"
```

---

### Task 6: 动作映射全量测试 + 端到端验证

**Files:**
- Modify: `test/main/features/touchpoint-copy-contract.test.ts`

**Interfaces:**
- Consumes: `deriveTouchpointSettingsModel`（Task 3）；`ACTION_HANDLERS`（Task 4 CommonJS bridge）
- Produces: 动作映射不变量测试（新增 actionId 未注册 handler → FAIL）

- [ ] **Step 1: 写失败测试** — 追加到 `test/main/features/touchpoint-copy-contract.test.ts`：

```ts
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../../src/renderer/modules/touchpoint-settings.js', import.meta.url), 'utf-8');
const HANDLERS = SOURCE.match(/ACTION_HANDLERS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || '';
const handlerIds = new Set(
  [...HANDLERS.matchAll(/^\s{4}'([^']+)':/gm)].map((m) => m[1]),
);

describe('touchpoint action mapping', () => {
  it('every actionId the model can emit has a registered handler', () => {
    // 枚举 model 全部可能输出的 actionId：primaryAction + issues[].actionId
    const candidates = new Set<string>(['connection.connect']);
    const fixtures: Array<Record<string, unknown>> = [
      { overall: { status: 'off', chain: { connection: 'missing', authorization: 'missing', delivery: 'missing' }, issues: [] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'broken', delivery: 'missing' }, issues: [{ severity: 'error', step: 'authorization', reason: 'token_expired', actionId: 'authorization.reauth' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'broken' }, issues: [{ severity: 'error', step: 'delivery', reason: 'sync_failed', actionId: 'sync.retry' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'missing', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'authorization', reason: 'not_configured', actionId: 'authorize.begin' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'delivery', reason: 'no_resources', actionId: 'resources.discover' }] } },
      { overall: { status: 'attention', chain: { connection: 'ok', authorization: 'ok', delivery: 'missing' }, issues: [{ severity: 'warning', step: 'delivery', reason: 'not_configured', actionId: 'briefing.schedule' }] } },
    ];
    for (const fixture of fixtures) {
      const model = deriveTouchpointSettingsModel({ mode: 'real', messaging: { instanceId: 'f', botConnected: true, ownerConfigured: true }, authorization: { kind: 'connected', providerId: 'feishu' }, resources: { discovered: 1, selected: 1, ready: 1, failed: 0, unsupported: 0 }, sync: { state: 'ready', lastRunAt: null, nextRunAt: null, processed: 1, failed: 0 }, review: { pending: 0, confirmed: 0, rejected: 0, sourceInvalidated: 0 }, briefing: { state: 'preview_ready', destination: null, lastDelivery: null, pendingCandidateCount: 0 }, actions: [], overall: fixture.overall }, []);
      candidates.add(model.primaryAction);
      for (const issue of model.issues) if (issue.actionId) candidates.add(issue.actionId);
    }
    for (const id of candidates) {
      expect(handlerIds.has(id), `actionId '${id}' 未在 touchpoint-settings.js ACTION_HANDLERS 注册`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行确认（先失败或先通过均须如实记录）**

Run: `npm test -- test/main/features/touchpoint-copy-contract.test.ts`
Expected: PASS（若 Task 4 已注册全部动作）；若 FAIL 则补注册缺失动作后重跑。

- [ ] **Step 3: 全量回归 + 端到端验证**

Run: `npm test`（全量通过）
Run: `scripts/restart-mate.sh`，确认启动日志正常后做真实环境验证：
1. 触点页：未连接 → off 灰态 + 「连接一个飞书机器人」待办卡
2. 已连接未授权（或撤销授权后）→ attention + 授权待办卡，状态徽标「需要处理」
3. 全部就绪 → ready 绿态 + 简报卡（预览/测试/改时间）
4. 高级设置手风琴：折叠/展开正常；「停止读取数据」单步确认；「断开连接」强确认后实例消失
5. 连接管理页：soon 组一行灰字；飞书详情「你的飞书账号」显示昵称；消息样式/工作区在高级手风琴内
6. 全程用户可见文案无 ou_/Card JSON/颗粒度/实例（回调地址引导卡除外）

- [ ] **Step 4: Commit**

```bash
git add test/main/features/touchpoint-copy-contract.test.ts
git commit -m "test: 触点动作全量映射测试 + 端到端验证通过"
```

---

## Self-Review（计划自审）

**Spec 覆盖对照：**
- §3.1 hero 状态徽标三态 → Task 4（3b + i18n status 三态）✓
- §3.2 链路状态图替代 stepper/双面板 → Task 4 renderChainView + Task 3 model.chain ✓
- §3.3 待办卡（issues 直渲染、一卡一问一按钮）→ Task 4 renderIssueCards ✓
- §3.4 简报卡仅 ready 显示 → Task 4 render() `view.ready ? renderDelivery(view) : ''` ✓
- §3.5 高级设置折叠（初始折叠用 `<details>`）+ 停止读取/断开连接分层 → Task 4 renderAdvancedSettings + runAction ✓
- §4 连接管理页瘦身（soon 一行灰字、概念合并、断开连接）→ Task 5 ✓
- §5 后端 overall（含决策树、broken 优先、不变量）→ Task 1/2 + spec §5.1 微调（文案下沉前端，理由见 Global Constraints）✓
- §5.3 矛盾根因修复 → Task 3 authorizedLabel 回归测试 ✓
- §6 数据流/错误分层 → 渲染保持既有 refresh/推送；错误仍走 notice ✓（无新代码，无需任务）
- §7 测试计划 1-5 → Task 1（一致性契约）、Task 3（矛盾回归）、Task 6（术语 unit+integration 双保险→copy-contract 测试、动作映射）✓
- §8 实施顺序 → Task 1→6 与之一致 ✓

**占位符扫描：** 无 TBD/TODO；每步含完整代码或精确修改位置。

**类型一致性：** `DashboardAction` 扩展（Task 1 Step 1）→ issues.actionId 类型（Task 1 Step 4）→ 前端 model/ACTION_HANDLERS（Task 3/4）→ 映射测试（Task 6）同名同值；`authorizedLabel`（Task 3）→ 渲染引用（Task 4 3a/3b）一致。
