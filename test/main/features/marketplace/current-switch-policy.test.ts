import * as fs from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord } from '../../../../src/main/features/cogseed_backend/types';

const listCogSeedTasks = vi.fn<(userId: string) => Promise<CogSeedTaskRecord[]>>();

vi.mock('../../../../src/main/features/cogseed_backend/task-store', () => ({
  listCogSeedTasks: (userId: string) => listCogSeedTasks(userId),
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const policy = await import('../../../../src/main/features/marketplace/current-switch-policy');

const SRC = path.resolve(__dirname, '../../../../src');
const UID = 'u_switch';
const CONTENT_ID = 'a1b2c3d4e5f6';

/** 本模块之外，**不得感知**该取值的七个组件。 */
const SEVEN_COMPONENTS = [
  'main/features/marketplace/source-fetch.ts',                 // 下载 + 校验
  'main/features/marketplace_bundle.ts',                       // 临时区流式落盘
  'main/features/marketplace/version-store.ts',                // 版本副本写入
  'main/features/marketplace/pin-scan.ts',                     // pin 扫描
  'main/features/marketplace/version-gc.ts',                   // 回收
  'main/features/cogseed_backend/task-store.ts',               // pin 产生
  'main/features/cogseed_runtime/kernel/tools/skill-tools.ts', // pin 解析
];

function task(status: string, contentId = CONTENT_ID, version = '1.0.0'): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: [{ skillId: contentId, version, manifestHash: 'h'.repeat(64) }],
  } as unknown as CogSeedTaskRecord;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

beforeEach(() => {
  listCogSeedTasks.mockReset();
  listCogSeedTasks.mockResolvedValue([]);
});

describe('marketplace/current-switch-policy（M1 的唯一决策点）', () => {
  describe('取值已收口为 defer-while-pinned（冻结 PRD §7.5 字面）', () => {
    it('默认取值是 defer-while-pinned', () => {
      expect(policy.CURRENT_SWITCH_POLICY).toBe('defer-while-pinned');
    });

    it('有进行中的使用 → 推迟推进 current install', async () => {
      listCogSeedTasks.mockResolvedValue([task('running')]);
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID))
        .resolves.toEqual({ advance: false, reason: 'deferred-active-use' });
    });

    it('⭐ recoverable 也算进行中 → 同样推迟', async () => {
      listCogSeedTasks.mockResolvedValue([task('recoverable')]);
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID))
        .resolves.toMatchObject({ advance: false });
    });

    it('使用已结束（终态）→ 可以推进', async () => {
      listCogSeedTasks.mockResolvedValue([task('completed')]);
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID))
        .resolves.toEqual({ advance: true, reason: 'no-active-use' });
    });

    it('别的内容在用不影响本内容', async () => {
      listCogSeedTasks.mockResolvedValue([task('running', 'other0000000')]);
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID))
        .resolves.toMatchObject({ advance: true });
    });

    it('⚠️ pin 扫描不可信 → 推迟而不是推进（保守侧是不替换）', async () => {
      listCogSeedTasks.mockRejectedValue(new Error('CogSeed task disappeared during recovery'));
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID))
        .resolves.toMatchObject({ advance: false });
    });
  });

  describe('⭐ T056 可翻转性（SC-010）', () => {
    it('翻到 immediate：不看使用状态，一律推进', async () => {
      listCogSeedTasks.mockResolvedValue([task('running')]);
      await expect(policy.decideCurrentSwitch(UID, CONTENT_ID, 'immediate'))
        .resolves.toEqual({ advance: true, reason: 'policy-immediate' });
    });

    it('翻到 immediate 时根本不去扫描——取值决定是否需要这项输入', async () => {
      await policy.decideCurrentSwitch(UID, CONTENT_ID, 'immediate');
      expect(listCogSeedTasks).not.toHaveBeenCalled();
    });

    it('两种取值下「一次已开始的使用读到的版本」不变：解析走版本副本，与本取值无关', () => {
      // 判据落在结构上：解析路径不引用本模块，故取值翻转不可能改变它。
      const resolver = fs.readFileSync(
        path.join(SRC, 'main/features/cogseed_runtime/kernel/tools/skill-tools.ts'), 'utf8',
      );
      expect(resolver).not.toContain('current-switch-policy');
      expect(resolver).not.toContain('CURRENT_SWITCH_POLICY');
    });
  });

  describe('⭐ T055 扩散检测（FR-037 第 2 条）', () => {
    it('取值标识符只出现在本模块中', () => {
      const offenders: string[] = [];
      for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (rel === 'main/features/marketplace/current-switch-policy.ts') continue;
        const src = fs.readFileSync(file, 'utf8');
        if (src.includes('defer-while-pinned') || src.includes('CURRENT_SWITCH_POLICY')) {
          offenders.push(rel);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('七个组件都不感知该取值，连决策函数也不引用', () => {
      const offenders: string[] = [];
      for (const rel of SEVEN_COMPONENTS) {
        const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
        if (src.includes('current-switch-policy') || src.includes('decideCurrentSwitch')) {
          offenders.push(rel);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('决策点被调用的地方只有一处（更新流程）', () => {
      const callers: string[] = [];
      for (const file of walk(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        if (rel === 'main/features/marketplace/current-switch-policy.ts') continue;
        if (fs.readFileSync(file, 'utf8').includes('decideCurrentSwitch')) callers.push(rel);
      }
      expect(callers).toEqual(['main/features/marketplace_reconcile.ts']);
    });

    it('更新流程里恰好调用一次', () => {
      const src = fs.readFileSync(path.join(SRC, 'main/features/marketplace_reconcile.ts'), 'utf8');
      expect(src.split('await decideCurrentSwitch(').length - 1).toBe(1);
    });
  });

  describe('复用唯一一份 pin 扫描', () => {
    it('本模块不自建扫描，也不维护与 pin 平行的 active-use 状态', () => {
      const raw = fs.readFileSync(
        path.join(SRC, 'main/features/marketplace/current-switch-policy.ts'), 'utf8',
      );
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).toContain("from './pin-scan'");
      expect(code).not.toContain('task-store');
      expect(code).not.toMatch(/writeFile|registry|refCount/i);
    });
  });
});
