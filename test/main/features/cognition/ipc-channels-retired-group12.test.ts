import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 已退役 IPC 通道不得重新注册或出现在基线 fixture 中。
 * 仅服务于退役通道的函数不再从 cognition 聚合出口导出；仍有消费者的
 * 读取函数保留。源码注册表、运行时导出与 fixture 三面保持一致。 */

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const RETIRED_CHANNELS = [
  'kb.share.needsUpdate',
  'kb.share.appConfig.get',
  'kb.share.appConfig.clear',
  'kb.share.cogseed.update',
  'kb.share.cogseed.list',
  'kb.share.cogseed.config.get',
  'cognition.receipts.list',
  'cognition.receipts.read',
  'cognition.reviewDecisions.list',
  'cognition.skills.audit',
];

const ipcSource = readFileSync(resolve(__dirname, '../../../../src/main/ipc/index.ts'), 'utf8');
const fixtureSource = readFileSync(
  resolve(__dirname, '../recall/fixtures/ipc-channel-baseline-014.txt'),
  'utf8',
);

describe('渲染零调用通道退役', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('ipc/index.ts 不得再注册已退役的 10 条通道', () => {
    const registered = [...ipcSource.matchAll(/^  '([A-Za-z0-9_.-]+)':/gm)].map((m) => m[1]);
    const revived = RETIRED_CHANNELS.filter((name) => registered.includes(name));
    expect(revived, '已退役通道被复活，需重审渲染零调用前提并同步基线 fixture').toEqual([]);
  });

  it('基线 fixture 不得把已退役通道列回去', () => {
    const lines = fixtureSource.split('\n').map((line) => line.trim());
    const relisted = RETIRED_CHANNELS.filter((name) => lines.includes(name));
    expect(relisted, 'fixture 与通道现状漂移（014 集合比较会红）').toEqual([]);
  });

  it('唯一消费者为死通道的服务函数不得从 cognition 聚合出口复活', async () => {
    const cognition = await import('../../../../src/main/features/cognition');
    const aggregate = cognition as unknown as Record<string, unknown>;
    expect(aggregate.getSkillVersionMigrationAudit, 'getSkillVersionMigrationAudit 已随 cognition.skills.audit 通道退役').toBeUndefined();
    expect(aggregate.readCognitionReuseReceipt, 'readCognitionReuseReceipt 已随 cognition.receipts.read 通道退役').toBeUndefined();
    // 保留侧钉住：有活消费者的服务函数仍在聚合出口上（删通道不删服务）。
    expect(typeof aggregate.listCognitionReuseReceipts).toBe('function');
    expect(typeof aggregate.listRecentReviewDecisions).toBe('function');
  });
});
