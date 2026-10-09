// 内置预设的本地覆盖（窗口 / 最大输出）——存储 + 校验 + 运行时效力。
//
// 2026-09-14：内置 provider 的模型参数此前既不可见也不可改，而运行时预算
// （上下文压缩阈值、max_tokens）就挂在这些数字上。本文件钉住：
//   1. 真实磁盘回路的 set/resolve/list/clear
//   2. 校验（正整数、上限、maxTokens ≤ 生效窗口，含"只覆盖一半"的情形）
//   3. 面板三态（预设 / 生效 / 是否已覆盖）
//   4. 覆盖真的进入运行时：模型层解析器 + DeepSeek 适配器 + 模型下拉

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'model-override-user';
let root: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-overrides-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  vi.resetModules();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const PRESET = { contextWindow: 1000000, maxTokens: 384000 };

describe('内置预设的本地覆盖（窗口 / 最大输出）', () => {
  it('真实磁盘回路：写入 → 冷读 → 列出 → 清除', async () => {
    const overrides = await import('../../../src/main/features/model_overrides');
    expect(overrides.resolveModelOverride(UID, 'deepseek', 'deepseek-v4-pro')).toBeNull();

    const written = overrides.setModelOverride(
      UID,
      'deepseek',
      'deepseek-v4-pro',
      { contextWindow: 512000, maxTokens: 65536 },
      PRESET,
    );
    expect(written.ok).toBe(true);

    // 冷启动读回（清进程内缓存 → 强制读文件）
    overrides._resetModelOverridesCacheForTest();
    expect(overrides.resolveModelOverride(UID, 'deepseek', 'deepseek-v4-pro'))
      .toMatchObject({ contextWindow: 512000, maxTokens: 65536 });
    expect(overrides.listModelOverrides(UID).deepseek['deepseek-v4-pro'])
      .toMatchObject({ contextWindow: 512000, maxTokens: 65536 });
    // 落盘位置由 paths 决定（cloud/config），不在这里复制目录布局
    const paths = await import('../../../src/main/paths');
    expect(fs.existsSync(paths.userModelOverridesFile(UID))).toBe(true);

    expect(overrides.clearModelOverride(UID, 'deepseek', 'deepseek-v4-pro')).toEqual({ ok: true, cleared: true });
    overrides._resetModelOverridesCacheForTest();
    expect(overrides.resolveModelOverride(UID, 'deepseek', 'deepseek-v4-pro')).toBeNull();
    // 幂等：再清一次不报错、不写脏数据
    expect(overrides.clearModelOverride(UID, 'deepseek', 'deepseek-v4-pro')).toEqual({ ok: true, cleared: false });
  });

  it('校验：正整数、上限、最大输出不得超过生效窗口', async () => {
    const overrides = await import('../../../src/main/features/model_overrides');
    expect(overrides.setModelOverride(UID, 'deepseek', 'm', { contextWindow: 0 }, PRESET).ok).toBe(false);
    expect(overrides.setModelOverride(UID, 'deepseek', 'm', { contextWindow: 20_000_000 }, PRESET).ok).toBe(false);
    expect(overrides.setModelOverride(UID, 'deepseek', 'm', { maxTokens: 2_000_000 }, PRESET).ok).toBe(false);
    // 只覆盖输出：预设窗口参与校验 → 500000 > 1000000 允许；再收紧窗口后不允许
    expect(overrides.setModelOverride(UID, 'deepseek', 'm', { maxTokens: 500000 }, PRESET).ok).toBe(true);
    const tightened = overrides.setModelOverride(UID, 'deepseek', 'm', { contextWindow: 256000 }, PRESET);
    expect(tightened).toMatchObject({ ok: false, error: 'maxTokens must not exceed contextWindow' });
    // 显式 null = 删掉该字段（回到预设值）
    const cleared = overrides.setModelOverride(UID, 'deepseek', 'm', { maxTokens: null }, PRESET);
    expect(cleared.ok).toBe(true);
    expect(overrides.resolveModelOverride(UID, 'deepseek', 'm')).toBeNull();
  });

  it('面板三态：预设值 / 生效值 / 是否已覆盖', async () => {
    const overrides = await import('../../../src/main/features/model_overrides');
    overrides.setModelOverride(UID, 'deepseek', 'deepseek-v4-pro', { contextWindow: 512000 }, PRESET);
    const rows = overrides.describeModelAbilityOverrides(UID, 'deepseek', [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, maxTokens: 384000 },
    ]);
    expect(rows[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      preset: { contextWindow: 1000000, maxTokens: 384000 },
      effective: { contextWindow: 512000, maxTokens: 384000 },
      overridden: true,
    });
    expect(rows[1]).toMatchObject({
      id: 'deepseek-flash',
      preset: { contextWindow: 1000000, maxTokens: 384000 },
      effective: { contextWindow: 1000000, maxTokens: 384000 },
      overridden: false,
    });
  });

  it('覆盖真的进入运行时：解析器 → 适配器 → 模型下拉', async () => {
    const overrides = await import('../../../src/main/features/model_overrides');
    overrides.setModelOverride(UID, 'deepseek', 'deepseek-v4-pro', { contextWindow: 512000 }, PRESET);
    overrides.installModelOverrideResolver();

    const registry = await import('../../../src/main/model/model_ability_overrides');
    const resolved = registry.modelAbilityOverrideFor('deepseek', 'deepseek-v4-pro');
    expect(resolved).toMatchObject({ contextWindow: 512000 });
    // 未覆盖的模型不受影响（解析器落空 → 预设值）
    expect(registry.modelAbilityOverrideFor('deepseek', 'deepseek-flash')).toBeNull();

    const { buildDeepSeekModel } = await import('../../../src/main/model/core-agent/external-providers');
    const model = buildDeepSeekModel('deepseek-v4-pro', resolved) as unknown as { contextWindow: number; maxTokens: number };
    expect(model.contextWindow).toBe(512000);
    // 只覆盖窗口：输出仍走预设（384K），不是适配器旧兜底 8192
    expect(model.maxTokens).toBe(384000);

    const auth = await import('../../../src/main/features/auth');
    const list = await auth.listModels('deepseek');
    expect(list.models.find((entry) => entry.id === 'deepseek-v4-pro'))
      .toMatchObject({ contextWindow: 512000, maxTokens: 384000 });
    expect(list.models.find((entry) => entry.id === 'deepseek-flash'))
      .toMatchObject({ contextWindow: 1000000, maxTokens: 384000 });
  });

  it('覆盖进入 rotating 候选 cap（pi-ai 内置路径，2026-09-14 修复）', async () => {
    // rotating 层的 paramsFor 会用候选自己的 cap 无条件覆盖请求参数；此前
    // pi-ai 分支取目录原值（不套 override），预设详情写下的输出上限被抹掉
    // ——external 路径恰好被上面的用例覆盖到，这条钉住 pi-ai 路径。
    const overrides = await import('../../../src/main/features/model_overrides');
    overrides.installModelOverrideResolver();
    const { rotatingCandidateMaxTokens } = await import('../../../src/main/model/core-agent/runner');

    const resolved = { model: { id: 'claude-test-model', contextWindow: 200000, maxTokens: 8192 } };
    // 未覆盖：目录原值直通
    expect(rotatingCandidateMaxTokens('u', 'anthropic', 'claude-test-model', false, resolved, undefined))
      .toBe(8192);
    // 覆盖输出上限：rotating 候选 cap 跟随（设置页显示与实际请求一致）
    overrides.setModelOverride(UID, 'anthropic', 'claude-test-model', { maxTokens: 100000 }, { contextWindow: 200000, maxTokens: 8192 });
    expect(rotatingCandidateMaxTokens(UID, 'anthropic', 'claude-test-model', false, resolved, undefined))
      .toBe(100000);
    // resolvedModel 缺失（未知模型）：只剩 {id}，override 仍生效；未覆盖时 undefined
    expect(rotatingCandidateMaxTokens(UID, 'anthropic', 'claude-test-model', false, null, undefined))
      .toBe(100000);
  });
});
