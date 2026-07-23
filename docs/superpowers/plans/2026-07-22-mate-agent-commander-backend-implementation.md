# Mate Agent Commander Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 为第三版 Mate Agent 增加可配置的指挥官后端，让设置页能够在 Orkas Core Agent 与 Hermes CLI 之间切换，并保持现有云模型授权、Wake Gate、KSTAR 和 ExperienceCandidate 行为不变。

**Architecture:** 保留现有 Orkas Core Agent 作为默认指挥官链路，在用户偏好中新增 `commander_backend` 角色绑定配置；主进程通过统一的 Commander Backend 解析器决定走现有 `chatWithModel` 路径还是 Hermes CLI Adapter 路径。设置页继续复用现有 `auth` 模型授权能力，只额外增加指挥官后端选择、Hermes 检测状态与可选模型 ID 输入，不新建第二套密钥系统。

**Tech Stack:** Electron 41、TypeScript、JavaScript、Vitest、React renderer、IPC、现有 `auth` / `local_agents` / `group_chat` / `preferences` 存储、Hermes ACP CLI 后端、JSON preferences、本地文件测试。

---

## 1. File Structure

### New files

- `src/main/features/commander_backend.ts` — 指挥官后端设置、校验、解析和运行时视图。
- `src/main/features/commander_backends/hermes.ts` — Hermes 指挥官 Adapter，复用现有 ACP 本地 CLI 后端。
- `test/main/features/commander-backend-settings.test.ts` — preferences 里指挥官后端设置的默认值、读写和校验测试。
- `test/main/features/commander-backend-routing.test.ts` — 主进程的后端选择与 Hermes 检测视图测试。
- `test/main/features/commander-backend-hermes.test.ts` — Hermes Adapter 最小文本模式与结构化决策解析测试。
- `test/renderer/settings-commander-backend.test.ts` — 设置页指挥官后端 UI 渲染和保存测试。

### Modified files

- `src/main/features/config.ts` — `UserPreferences` 增加 `commander_backend`，并导出读写 helper。
- `src/main/ipc/index.ts` — 新增 `settings.getCommanderBackend` / `settings.setCommanderBackend` / `settings.detectCommanderBackends`。
- `src/main/features/group_chat/bus.ts` — 指挥官 turn 运行时根据 backend 选择 Orkas Core Agent 或 Hermes Adapter。
- `src/renderer/index.html` — 在设置页 credentials 区增加指挥官后端配置区块。
- `src/renderer/modules/settings.js` — 读取、渲染、保存指挥官后端配置，并显示 Hermes 可用性。
- `src/renderer/locales/zh.json` — 新增中文文案。
- `src/renderer/locales/en.json` — 新增英文文案。

### Explicitly unchanged compatibility surfaces

- `auth-profiles.json` 与 `auth.entries` 的云模型授权语义。
- 现有 Orkas Core Agent 默认指挥官路径。
- `window.orkas`、`ORKAS_*`、`.orkas`、`orkas-pkg.cjs`、`__orkas-meta.json` 等兼容面。
- P3394 Wake Gate、KSTAR、Verification、ExperienceCandidate 的事实源边界。

---

## 2. Task 1: Add commander backend preferences and validation

**Files:**
- Modify: `src/main/features/config.ts`
- Create: `test/main/features/commander-backend-settings.test.ts`

- [ ] **Step 1: Write the failing preference test**

Create `test/main/features/commander-backend-settings.test.ts` with tests that assert:

```ts
import { describe, expect, it } from 'vitest';
import { readPreferences, getCommanderBackendSettings, setCommanderBackendSettings } from '../../../src/main/features/config';

describe('commander backend settings', () => {
  it('defaults to Orkas Core Agent when no preference exists', () => {
    expect(getCommanderBackendSettings()).toEqual({
      backend: 'orkas-core-agent',
      authEntryId: null,
      localCli: null,
    });
  });

  it('persists Hermes CLI selection without storing secrets', () => {
    setCommanderBackendSettings({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: { type: 'hermes', model: '', useCliDefaultModel: true },
    });
    expect(readPreferences().commander_backend).toMatchObject({
      backend: 'hermes-cli',
      authEntryId: null,
      localCli: { type: 'hermes', model: '', useCliDefaultModel: true },
    });
  });

  it('rejects unknown backend kinds', () => {
    expect(() => setCommanderBackendSettings({
      backend: 'unknown' as never,
      authEntryId: null,
      localCli: null,
    })).toThrow('invalid commander backend');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-settings.test.ts
```

Expected: FAIL because `commander_backend` and the helper functions do not exist yet.

- [ ] **Step 3: Add the preference model and helpers**

In `src/main/features/config.ts`, add:

```ts
export type CommanderBackendKind = 'orkas-core-agent' | 'hermes-cli';

export interface CommanderBackendSettings {
  backend: CommanderBackendKind;
  authEntryId?: string | null;
  localCli?: {
    type: 'hermes';
    model?: string;
    useCliDefaultModel?: boolean;
  } | null;
}

export interface UserPreferences {
  // existing fields...
  commander_backend?: CommanderBackendSettings;
}

export function getCommanderBackendSettings(): CommanderBackendSettings {
  return readPreferences().commander_backend || {
    backend: 'orkas-core-agent',
    authEntryId: null,
    localCli: null,
  };
}

export function setCommanderBackendSettings(settings: CommanderBackendSettings): CommanderBackendSettings {
  if (settings.backend !== 'orkas-core-agent' && settings.backend !== 'hermes-cli') {
    throw new Error('invalid commander backend');
  }
  if (settings.backend === 'hermes-cli' && settings.localCli?.type !== 'hermes') {
    throw new Error('hermes backend requires hermes localCli settings');
  }
  writePreferences({ commander_backend: settings });
  return settings;
}
```

Keep the helper small and deterministic; do not store API keys or model-provider secrets here.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-settings.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the preference model work**

```bash
git add src/main/features/config.ts test/main/features/commander-backend-settings.test.ts
git commit -m "feat: persist Mate Agent commander backend settings"
```

---

## 3. Task 2: Add IPC and runtime backend resolution

**Files:**
- Create: `src/main/features/commander_backend.ts`
- Modify: `src/main/ipc/index.ts`
- Create: `test/main/features/commander-backend-routing.test.ts`

- [ ] **Step 1: Write the failing runtime-routing test**

Create `test/main/features/commander-backend-routing.test.ts` with tests that assert:

```ts
import { describe, expect, it } from 'vitest';
import { getCommanderBackendView, resolveCommanderBackend } from '../../../src/main/features/commander_backend';

describe('commander backend routing', () => {
  it('defaults to Orkas Core Agent', async () => {
    const view = await getCommanderBackendView();
    expect(view.settings.backend).toBe('orkas-core-agent');
  });

  it('surfaces Hermes availability in the backend view', async () => {
    const view = await getCommanderBackendView();
    expect(view.hermes).toEqual(expect.objectContaining({
      available: expect.any(Boolean),
      path: expect.anything(),
      version: expect.anything(),
    }));
  });

  it('resolves Hermes when explicitly selected', async () => {
    const resolved = await resolveCommanderBackend({ backend: 'hermes-cli', localCli: { type: 'hermes', useCliDefaultModel: true } });
    expect(resolved.backend).toBe('hermes-cli');
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-routing.test.ts
```

Expected: FAIL because `commander_backend.ts` and the IPC handlers do not exist yet.

- [ ] **Step 3: Add the backend resolver module**

Create `src/main/features/commander_backend.ts` with a small, explicit surface:

```ts
export interface CommanderBackendHermesView {
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

export interface CommanderBackendView {
  settings: CommanderBackendSettings;
  cloudConfigured: boolean;
  hermes: CommanderBackendHermesView;
}

export async function getCommanderBackendView(): Promise<CommanderBackendView> { /* ... */ }
export async function resolveCommanderBackend(input?: CommanderBackendSettings): Promise<CommanderBackendSettings> { /* ... */ }
```

Implementation guidance:

- Use the helper from Task 1 for persisted settings.
- Do not auto-write secrets.
- Do not auto-switch the user to Hermes if Hermes is unavailable; surface the failure in the view.

- [ ] **Step 4: Add IPC handlers**

In `src/main/ipc/index.ts`, add:

```ts
'settings.getCommanderBackend': async () => commanderBackend.getCommanderBackendView(),
'settings.setCommanderBackend': async ({ settings }) => commanderBackend.setCommanderBackendSettings(settings),
'settings.detectCommanderBackends': async () => commanderBackend.detectCommanderBackends(),
```

Keep the existing `auth.*` handlers unchanged.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-settings.test.ts test/main/features/commander-backend-routing.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the backend-routing work**

```bash
git add src/main/features/commander_backend.ts src/main/ipc/index.ts test/main/features/commander-backend-routing.test.ts
git commit -m "feat: add commander backend resolution and IPC"
```

---

## 4. Task 3: Add settings UI for commander backend selection

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/settings.js`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Create: `test/renderer/settings-commander-backend.test.ts`

- [ ] **Step 1: Write the failing renderer test**

Create `test/renderer/settings-commander-backend.test.ts` with a VM-based settings sandbox patterned after the existing settings tests:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('settings commander backend', () => {
  it('renders the commander backend section and saves a Hermes selection', async () => {
    // load settings.js in a sandbox
    // mock window.orkas.invoke for settings.getCommanderBackend / settings.setCommanderBackend
    // assert the backend selector and Hermes model input exist
  });
});
```

Use the existing pattern from `test/renderer/settings-model-whitelist.test.ts` and assert that the sandbox exposes a render helper such as `_settingsRenderCommanderBackend` or that the DOM IDs appear in the render tree.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:js -- test/renderer/settings-commander-backend.test.ts
```

Expected: FAIL because the settings pane and wiring do not exist yet.

- [ ] **Step 3: Add the settings pane markup and behavior**

In `src/renderer/index.html`, add a new block inside the credentials/settings area with stable IDs for:

```text
settings-commander-backend-select
settings-commander-auth-entry
settings-commander-hermes-model
settings-commander-hermes-status
settings-commander-backend-save
```

In `src/renderer/modules/settings.js`, add helpers that:

1. Fetch `settings.getCommanderBackend`.
2. Fetch `settings.detectCommanderBackends` when the section mounts or refreshes.
3. Render the backend selector.
4. Show Hermes availability and path.
5. Allow a blank Hermes model field to mean “use CLI default”.
6. Call `settings.setCommanderBackend` on save.

Keep the existing model authorization picker intact; this is an additive role-binding layer, not a replacement.

- [ ] **Step 4: Add localization strings**

Update `src/renderer/locales/zh.json` and `src/renderer/locales/en.json` with strings for:

- 指挥官后端 / Commander backend
- Orkas Core Agent
- Hermes CLI
- Hermes 已安装 / 未安装
- 使用 Hermes 默认模型 / Use Hermes default model
- 切换后端 / Switch backend

- [ ] **Step 5: Run renderer tests and verify the UI passes**

Run:

```bash
npm run test:js -- test/renderer/settings-commander-backend.test.ts test/renderer/settings-model-whitelist.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the settings UI work**

```bash
git add src/renderer/index.html src/renderer/modules/settings.js src/renderer/locales/zh.json src/renderer/locales/en.json test/renderer/settings-commander-backend.test.ts
git commit -m "feat: add commander backend settings UI"
```

---

## 5. Task 4: Wire Hermes CLI commander adapter into group chat

**Files:**
- Create: `src/main/features/commander_backends/hermes.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Create: `test/main/features/commander-backend-hermes.test.ts`

- [ ] **Step 1: Write the failing Hermes adapter test**

Create `test/main/features/commander-backend-hermes.test.ts` with two tests:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runHermesCommander } from '../../../src/main/features/commander_backends/hermes';

describe('Hermes commander adapter', () => {
  it('returns plain commander text when Hermes emits only text', async () => {
    // mock the ACP runner and assert plain text comes back unchanged
  });

  it('accepts a strict CommanderDecision JSON payload when Hermes emits one', async () => {
    // mock ACP output like { kind: 'dispatch_to', targetAgentId: 'agent-1', task: '...' }
    // assert the parser accepts only whitelisted fields
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-hermes.test.ts
```

Expected: FAIL because the Hermes commander adapter does not exist yet.

- [ ] **Step 3: Implement the Hermes commander adapter**

Create `src/main/features/commander_backends/hermes.ts` as a minimal adapter over the existing Hermes ACP backend.

The adapter should:

1. Reuse the existing Hermes ACP launch path from `src/main/features/local_agents/backends/hermes.ts`.
2. Feed the commander system prompt and user input into the CLI.
3. Return plain text if Hermes returns a normal text answer.
4. Accept a strict JSON object only if it matches a whitelisted CommanderDecision shape.
5. Never execute side effects directly.
6. Leave dispatch, wake approval, and KSTAR writes to the existing Orkas/P3394 runtime.

Suggested minimal decision shape:

```ts
export interface CommanderDecision {
  kind: 'reply' | 'dispatch_to' | 'hand_off_to' | 'run_worker' | 'ask_user';
  targetAgentId?: string;
  task?: string;
  message?: string;
  reason?: string;
}
```

- [ ] **Step 4: Route commander turns through the backend resolver**

In `src/main/features/group_chat/bus.ts`, keep the existing Orkas path as the default branch and add a backend selection step before commander execution.

Behavior:

```text
backend = orkas-core-agent
  → existing chatWithModel / streamChatWithModel path

backend = hermes-cli
  → runHermesCommander()
  → parse plain text or CommanderDecision
  → continue through the existing bus / persistence pipeline
```

Do not let Hermes bypass:

- `dispatch_to`
- `hand_off_to`
- `run_worker`
- Wake Gate
- KSTAR
- Evidence logging

- [ ] **Step 5: Run the adapter test and end-to-end routing tests**

Run:

```bash
npm run test:js -- test/main/features/commander-backend-hermes.test.ts test/main/features/commander-backend-routing.test.ts test/main/features/commander-backend-settings.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the Hermes adapter work**

```bash
git add src/main/features/commander_backends/hermes.ts src/main/features/group_chat/bus.ts test/main/features/commander-backend-hermes.test.ts
git commit -m "feat: route commander through Hermes CLI backend"
```

---

## 6. Task 5: Full verification and Electron QA

**Files:**
- No new files expected; this is validation only.

- [ ] **Step 1: Run the full JS/TS suite**

Run:

```bash
git diff --check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 npm test
```

Expected: all pass.

- [ ] **Step 2: Run a targeted Electron QA pass**

Verify in the Mate Agent UI:

1. Open Settings.
2. Confirm the new commander backend section is visible.
3. Confirm Orkas Core Agent is the default.
4. Switch to Hermes CLI.
5. Confirm Hermes availability/path/version are shown.
6. Save the setting and refresh; selection persists.
7. Confirm blank Hermes model uses CLI default.
8. Confirm switching back to Orkas Core Agent restores the existing model authorization path.

- [ ] **Step 3: Commit the finished feature branch state**

If the implementation is complete and the QA pass is green, commit the remaining changes with a summary message such as:

```bash
git add .
git commit -m "feat: add configurable commander backend"
```

---

## 7. Coverage Check Against the Spec

### Covered

- **Section 2 goals:** Task 1–4.
- **Section 4 current facts:** Task 2–4 reuse existing auth and Hermes code.
- **Section 6 settings design:** Task 3.
- **Section 7 data structures:** Task 1.
- **Section 8 main-process IPC:** Task 2.
- **Section 9 runtime calling design:** Task 4.
- **Section 10 LiveAgent relationship:** Task 1–3 keep a single config system and reuse auth/local agents.
- **Section 11 error handling:** Task 2–4 tests cover unavailable Hermes, invalid backend, and parse failures.
- **Section 12 security and permissions:** Task 4 explicitly keeps Hermes behind the existing bus / P3394 flow.
- **Section 13 testing plan:** Task 1–5.
- **Section 14 acceptance:** Task 5.

### Intentionally deferred

- Full PRM Agent.
- Full structured EvaluationSpec / PRMEvaluationReport.
- Hermes dynamic model discovery.
- Multi-device / cloud sync / team config.

These remain out of scope for this plan and will be handled later if the product direction expands.

---

## 8. Notes for the implementer

- Keep the default behavior unchanged for existing users.
- Do not create a second secrets store.
- Do not let the renderer call Hermes directly.
- Keep Hermes as an opt-in commander backend until QA proves it is safe.
- Use small commits after each task so regressions are easy to isolate.

