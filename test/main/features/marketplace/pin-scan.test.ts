import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CogSeedTaskRecord, CogSeedTaskStatus } from '../../../../src/main/features/cogseed_backend/types';

const listCogSeedTasks = vi.fn<(userId: string) => Promise<CogSeedTaskRecord[]>>();

vi.mock('../../../../src/main/features/cogseed_backend/task-store', () => ({
  listCogSeedTasks: (userId: string) => listCogSeedTasks(userId),
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

const scan = await import('../../../../src/main/features/marketplace/pin-scan');

const UID = 'u_pin_scan';
const CONTENT_ID = 'a1b2c3d4e5f6';

/** 合成一条 Task 记录。只填扫描关心的字段，其余不影响判定。 */
function task(
  status: CogSeedTaskStatus | string,
  pins: Array<{ skillId: string; version: string }> = [{ skillId: CONTENT_ID, version: '1.2.0' }],
): CogSeedTaskRecord {
  return {
    status,
    skillVersionPins: pins.map((p) => ({ ...p, manifestHash: 'h'.repeat(64) })),
  } as unknown as CogSeedTaskRecord;
}

beforeEach(() => {
  listCogSeedTasks.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('marketplace/pin-scan', () => {
  describe('状态集合：9 个状态，终态只有 3 个（FR-051）', () => {
    it('三个终态与六个非终态合起来恰好是 9 个，且互不重叠', () => {
      const terminal = [...scan.TERMINAL_TASK_STATUSES];
      const nonTerminal = [...scan.NON_TERMINAL_TASK_STATUSES];

      expect(terminal.sort()).toEqual(['cancelled', 'completed', 'failed']);
      expect(nonTerminal.sort()).toEqual(
        ['created', 'planned', 'queued', 'recoverable', 'running', 'waiting_user'],
      );
      expect(new Set([...terminal, ...nonTerminal]).size).toBe(9);
    });

    it.each(['completed', 'failed', 'cancelled'] as const)('%s 是终态', (status) => {
      expect(scan.isTerminalTaskStatus(status)).toBe(true);
    });

    it.each(['planned', 'created', 'queued', 'running', 'waiting_user', 'recoverable'] as const)(
      '%s 不是终态',
      (status) => {
        expect(scan.isTerminalTaskStatus(status)).toBe(false);
      },
    );

    it('⭐ recoverable 不是终态——它可被恢复继续执行，pin 必须保留', () => {
      expect(scan.isTerminalTaskStatus('recoverable')).toBe(false);
      expect(scan.TERMINAL_TASK_STATUSES).not.toContain('recoverable');
    });

    it('未知状态按非终态处理：保守侧是留着，不是删掉', () => {
      expect(scan.isTerminalTaskStatus('some_future_status')).toBe(false);
      expect(scan.isTerminalTaskStatus(undefined)).toBe(false);
      expect(scan.isTerminalTaskStatus(null)).toBe(false);
      expect(scan.isTerminalTaskStatus('')).toBe(false);
    });
  });

  describe('在用集合（FR-050）', () => {
    it('终态 Task 的 pin 不计入', async () => {
      listCogSeedTasks.mockResolvedValue([task('completed'), task('failed'), task('cancelled')]);

      const result = await scan.scanActivePins(UID);

      expect(result.trustworthy).toBe(true);
      expect(result.scannedTasks).toBe(3);
      expect(result.activeTasks).toBe(0);
      expect(result.inUse.size).toBe(0);
    });

    it('六种非终态的 pin 全部计入', async () => {
      listCogSeedTasks.mockResolvedValue(
        scan.NON_TERMINAL_TASK_STATUSES.map((status, i) => task(status, [{ skillId: CONTENT_ID, version: `1.0.${i}` }])),
      );

      const result = await scan.scanActivePins(UID);

      expect(result.activeTasks).toBe(6);
      expect(result.inUse.size).toBe(6);
      for (let i = 0; i < 6; i += 1) {
        expect(result.inUse.has(scan.pinKey(CONTENT_ID, `1.0.${i}`))).toBe(true);
      }
    });

    it('⭐ recoverable 钉住的版本在在用集合里（回收不得删它）', async () => {
      listCogSeedTasks.mockResolvedValue([task('recoverable', [{ skillId: CONTENT_ID, version: '1.2.0' }])]);

      await expect(scan.hasActivePin(UID, CONTENT_ID, '1.2.0')).resolves.toBe(true);
    });

    it('同一版本被多个 Task 钉住只计一次', async () => {
      listCogSeedTasks.mockResolvedValue([task('running'), task('queued'), task('waiting_user')]);

      const result = await scan.scanActivePins(UID);

      expect(result.activeTasks).toBe(3);
      expect(result.inUse.size).toBe(1);
    });

    it('没有 pin 或 pin 字段畸形的 Task 不污染集合', async () => {
      listCogSeedTasks.mockResolvedValue([
        task('running', []),
        { status: 'running' } as unknown as CogSeedTaskRecord,
        { status: 'running', skillVersionPins: 'not-an-array' } as unknown as CogSeedTaskRecord,
        { status: 'running', skillVersionPins: [null, { skillId: '', version: '1.0.0' }, { skillId: 'x' }] } as unknown as CogSeedTaskRecord,
      ]);

      const result = await scan.scanActivePins(UID);

      expect(result.trustworthy).toBe(true);
      expect(result.inUse.size).toBe(0);
    });

    it('没有任何 Task 时是可信的空集，而不是不可信', async () => {
      listCogSeedTasks.mockResolvedValue([]);

      const result = await scan.scanActivePins(UID);

      expect(result.trustworthy).toBe(true);
      expect(result.inUse.size).toBe(0);
    });
  });

  describe('⭐ 扫描异常返回「不可信」而非空集（FR-053）', () => {
    it('listCogSeedTasks 抛错时 trustworthy 为 false，并带上原因', async () => {
      listCogSeedTasks.mockRejectedValue(new Error('CogSeed task disappeared during recovery'));

      const result = await scan.scanActivePins(UID);

      expect(result.trustworthy).toBe(false);
      expect(result.reason).toContain('disappeared');
      // 空集与「扫不出来」在磁盘上长得一样，含义却相反——靠 trustworthy 区分。
      expect(result.inUse.size).toBe(0);
    });

    it('不可信时 hasActivePin 返回 true：拿不准就当它在用', async () => {
      listCogSeedTasks.mockRejectedValue(new Error('EACCES'));

      await expect(scan.hasActivePin(UID, CONTENT_ID, '1.2.0')).resolves.toBe(true);
      await expect(scan.hasActivePinsForContent(UID, CONTENT_ID)).resolves.toBe(true);
    });

    it('不可信时不得被误读成「没有版本在用」——与真实空集的可信度必须不同', async () => {
      listCogSeedTasks.mockResolvedValue([]);
      const empty = await scan.scanActivePins(UID);

      listCogSeedTasks.mockRejectedValue(new Error('boom'));
      const broken = await scan.scanActivePins(UID);

      expect(empty.inUse.size).toBe(broken.inUse.size);
      expect(empty.trustworthy).not.toBe(broken.trustworthy);
    });

    it('扫描不抛错：失败一律以 trustworthy 表达', async () => {
      listCogSeedTasks.mockRejectedValue(new Error('boom'));
      await expect(scan.scanActivePins(UID)).resolves.toBeTruthy();
    });
  });

  describe('按内容查在用（供停用判定复用同一份扫描）', () => {
    it('任意版本在用即为 true', async () => {
      listCogSeedTasks.mockResolvedValue([task('running', [{ skillId: CONTENT_ID, version: '0.9.0' }])]);

      await expect(scan.hasActivePinsForContent(UID, CONTENT_ID)).resolves.toBe(true);
      await expect(scan.hasActivePin(UID, CONTENT_ID, '1.2.0')).resolves.toBe(false);
    });

    it('其他内容的 pin 不算在本内容头上', async () => {
      listCogSeedTasks.mockResolvedValue([task('running', [{ skillId: 'other000000', version: '1.2.0' }])]);

      await expect(scan.hasActivePinsForContent(UID, CONTENT_ID)).resolves.toBe(false);
    });
  });

  describe('结构约束：只有一份 pin 扫描', () => {
    it('marketplace/ 下只有 pin-scan.ts 依赖 task-store，不存在第二份扫描', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.join(__dirname, '../../../../src/main/features/marketplace');

      const importers = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .filter((f) => /from '\.\.\/cogseed_backend\/task-store'/.test(fs.readFileSync(path.join(dir, f), 'utf8')));

      expect(importers).toEqual(['pin-scan.ts']);
    });

    it('不引入与 pin 平行的 active-use state：本模块不落盘、不缓存集合', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const src = fs.readFileSync(
        path.join(__dirname, '../../../../src/main/features/marketplace/pin-scan.ts'), 'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

      // 引用是扫出来的，不是维护的——不得写文件、不得维护模块级计数或注册表。
      expect(src).not.toMatch(/writeFile|mkdir|rename/);
      expect(src).not.toMatch(/refCount|refcount|registry/i);
    });
  });

  describe('键的构造', () => {
    it('不同的 (content_id, version) 切分不会撞键', () => {
      // 单字符分隔符会让这两组撞键；JSON 数组不会。
      expect(scan.pinKey('a|b', 'c')).not.toBe(scan.pinKey('a', 'b|c'));
      expect(scan.pinKey('a', '1.0.0')).toBe(scan.pinKey('a', '1.0.0'));
    });
  });
});
