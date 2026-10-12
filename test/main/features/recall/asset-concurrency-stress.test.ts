/**
 * 认知资产 · 并发压力测试（2026-09-28 全量 debug 任务）。
 *
 * 验证 store 层 fileEditLock 在真实并发下的完整性：
 * 并发 update 同一资产 / 并发状态切换 / 并发创建 / 竞争写版本流，
 * 最终盘上记录必须无损、版本号连续、状态始终是合法枚举值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-concurrency-stress-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const [candidates, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, assets };
}

async function seedAsset(userId: string, statement = '并发种子。') {
  const { candidates, assets } = await modules();
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment: statement,
    // 标题闸门（设计 3.2）：无 summary 兜底＝正文首句，过不了闸门。
    summary: '压测种子样本',
    suggestedType: 'personal',
    suggestedScope: 'general',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'execution', id: `exec-${userId}` }],
    evidenceRefs: [{ kind: 'execution', id: `exec-${userId}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  return { candidates, assets, asset };
}

describe('并发压力：同一资产并发写', () => {
  it('20 笔并发 update：version 连续到 21、盘上 JSON 完整、statement 值合法', async () => {
    const uid = 'cc-update';
    const { assets, asset } = await seedAsset(uid);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      assets.updateAbilityAsset(uid, asset.id, { statement: `第${i}笔并发写入。`, reason: 'r', actor: 'user' })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    // 锁内串行：20 笔都应成功（每笔重读最新值再 bump）
    expect(ok.length).toBe(20);
    const final = await assets.readAbilityAsset(uid, asset.id);
    expect(final.version).toBe('21');
    expect(final.statement).toMatch(/^第\d+笔并发写入。$/);
    // 版本流 21 条（v1 + 20 次 bump），JSON 全部可解析
    const versions = await assets.listAbilityAssetVersions(uid, asset.id);
    expect(versions.map((v) => v.version)).toEqual(
      Array.from({ length: 21 }, (_, i) => String(i + 1)),
    );
    for (const v of versions) {
      expect(() => JSON.stringify(v.snapshot)).not.toThrow();
      expect(typeof v.snapshot.statement).toBe('string');
    }
  });

  it('10 pause + 10 resume 并发竞争：终态是合法枚举，台账无损坏', async () => {
    const uid = 'cc-flip';
    const { assets, asset } = await seedAsset(uid);
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i += 1) {
      jobs.push(assets.pauseAbilityAsset(uid, asset.id, { actor: 'user', reason: `p${i}` })
        .catch(() => 'rejected'));
      jobs.push(assets.resumeAbilityAsset(uid, asset.id, { actor: 'user', reason: `r${i}` })
        .catch(() => 'rejected'));
    }
    await Promise.allSettled(jobs);
    const final = await assets.readAbilityAsset(uid, asset.id);
    expect(['active', 'paused']).toContain(final.status);
    // 台账可读且动作都是合法值
    const audit = await assets.listAbilityAssetAudit(uid, asset.id);
    for (const row of audit) {
      expect(['created', 'paused', 'resumed', 'updated']).toContain(row.action);
    }
    expect(audit.length).toBeGreaterThanOrEqual(21); // created + 至多 20 次状态翻转
  });

  it('并发 delete 与 update 竞争：update 要么先入（成功）要么被终态守卫拒绝，绝无损坏中间态', async () => {
    const uid = 'cc-race';
    const { assets, asset } = await seedAsset(uid);
    const [del, upd] = await Promise.allSettled([
      assets.deleteAbilityAsset(uid, asset.id, { actor: 'user', reason: '删' }),
      assets.updateAbilityAsset(uid, asset.id, { statement: '竞争写入。', reason: 'r', actor: 'user' }),
    ]);
    const final = await assets.readAbilityAsset(uid, asset.id);
    if (del.status === 'fulfilled' && final.status === 'deleted') {
      // update 若在 delete 之后进入锁，必被守卫拒绝
      if (upd.status === 'fulfilled') {
        expect(final.version).toBe(upd.value.version);
      } else {
        expect(String(upd.reason)).toMatch(/cannot be changed/i);
      }
    } else {
      expect(final.status).toBe('active');
    }
    expect(typeof final.statement).toBe('string');
  });
});

describe('并发压力：多资产并行', () => {
  it('10 条资产并行创建+更新：互不串号，各自 version=2', async () => {
    const uid = 'cc-multi';
    // 种子语句彼此语义远离，避免被语义查重（score≥0.85）正当拦截
    const statements = [
      '用户希望回答先给结论再展开。',
      '用户偏好中文写作与中文注释。',
      '用户自我定位是文科转计算机的入门学习者。',
      '用户希望专业术语首次出现时用白话解释。',
      '用户的学习节奏是每天固定两小时。',
      '用户对数学推导需要从例子入手。',
      '用户习惯用表格对照多个选项。',
      '用户阅读代码前先看测试用例。',
      '用户喜欢把复杂任务拆成小步骤逐个完成。',
      '用户偏好简短直接的沟通方式。',
    ];
    const seeded = await Promise.all(statements.map((s) => seedAsset(uid, s)));
    await Promise.all(seeded.map(({ assets, asset }) =>
      assets.updateAbilityAsset(uid, asset.id, { statement: `${asset.statement}（已复核。）`, reason: 'r', actor: 'user' })));
    const list = await (await modules()).assets.listAbilityAssets(uid);
    expect(list.length).toBe(10);
    for (const row of list) {
      expect(row.version).toBe('2');
      expect(row.statement).toMatch(/（已复核。）$/);
      expect(row.status).toBe('active');
    }
  });

  it('同一 JSONL 版本流并发 append：行数与内容一一对应', async () => {
    const uid = 'cc-jsonl';
    const { assets, asset } = await seedAsset(uid);
    await Promise.all(Array.from({ length: 15 }, (_, i) =>
      assets.updateAbilityAsset(uid, asset.id, { statement: `流${i}`, reason: 'r', actor: 'user' })));
    const versions = await assets.listAbilityAssetVersions(uid, asset.id);
    expect(versions.length).toBe(16); // v1 + 15
    const seen = new Set(versions.map((v) => v.version));
    expect(seen.size).toBe(16);
  });
});
