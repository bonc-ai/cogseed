/**
 * 探针 r5（边界测试员 · 第 5 轮）→ 主题：删除生命周期「彻底清除」的可重入性。
 *
 * 疑点：purgeAbilityAsset 的执行序是 setStatus（先把主记录落成 purged 墓碑）→
 * removeRecallJsonlStream（删版本流）→ cascadePurgeAssetReferences（清引用）。
 * 后两步任一 IO 失败时主记录已是终态；重试会在入口被 assertNotPurged
 * （asset-service.ts setStatus 内）拒绝，而 store.ts 的
 * removeRecallJsonlStream / removeRecallJsonlRecords 注释明言
 * 「清除要可重入，半路失败后重试不该被绊住」——两处口径互相矛盾。
 *
 * 本探针用 chmod 只读版本流目录制造真实的级联 IO 失败（主记录目录不受影响），
 * 验证：① 首次 purge 半途而废但墓碑已落盘；② 恢复可写后重试被终态守卫拒绝；
 * ③ 版本流正文残留且保留期清扫（只扫 status==='deleted'）永远不会再碰它。
 * 风格对齐 test/质检/regression-r1-asset-lifecycle.test.ts。
 *
 * 2026-09-30 r1 收尾（记账员）：用例 1 对应待议 P-r1-1（重试豁免/级联先行/
 * 后台清扫三修法各有取舍待拍板）→ it.skip，断言锁定现状；用例 2 对照组
 * （无 IO 故障时正常清空，不依赖漏洞）保留 active，修复后应持续绿。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r5-purge';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r5a-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  try { fs.chmodSync(versionsDir(), 0o755); } catch { /* 目录可能不存在 */ }
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function assetFile(id: string): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'records', 'ability-assets', `${id}.json`);
}
function versionsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'recall', 'jsonl', 'ability-asset-versions');
}
function versionsFile(id: string): string {
  return path.join(versionsDir(), `${id}.jsonl`);
}

async function loadAssets() {
  return import('../../src/main/features/recall/asset-service');
}

async function mkAsset(id: string) {
  const assets = await loadAssets();
  const now = new Date().toISOString();
  return assets.createAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('probe r5 › purge 级联中途失败后的可重入性（用例 1 待议 P-r1-1）', () => {
  it.skip('级联 IO 失败：墓碑已落盘、重试被 assertNotPurged 拒绝、版本流正文永久残留（待议 P-r1-1，拍板前 skip）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5a');
    // 追加第二个版本，让版本流里有正文本可被清除
    await assets.updateAbilityAsset(UID, 'aa-p5a', { statement: '版本二正文r5。', reason: 'r', actor: 'user' } as any);
    const stream = versionsFile('aa-p5a');
    expect(fs.existsSync(stream)).toBe(true);
    expect(fs.readFileSync(stream, 'utf8')).toContain('版本二正文r5。');

    // 制造级联失败：版本流目录只读 → fs.rm 抛 EPERM/EACCES（主记录目录不受影响）
    fs.chmodSync(versionsDir(), 0o555);
    await expect(assets.purgeAbilityAsset(UID, 'aa-p5a', ACT)).rejects.toThrow();

    // setStatus 已先行把主记录落成墓碑（正文已从主记录清空）
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-p5a'), 'utf8')) as { status: string; statement: string };
    expect(raw.status).toBe('purged');
    expect(raw.statement).toBe('');

    // 恢复可写后重试：入口终态守卫拒绝（与 store.ts「清除要可重入」注释相悖）
    fs.chmodSync(versionsDir(), 0o755);
    await expect(assets.purgeAbilityAsset(UID, 'aa-p5a', ACT)).rejects.toThrow(/has been purged/);

    // 保留期清扫只扫 status==='deleted'：purged 残留永远不会再被触碰
    const retention = await import('../../src/main/features/recall/asset-retention-service');
    const sweep = await retention.runAbilityAssetRetentionSweep(UID);
    expect(sweep.purged).not.toContain('aa-p5a');
    expect(sweep.failed.map((f) => f.assetId)).not.toContain('aa-p5a');

    // 正文仍残留在版本流里，且无任何产品路径可再清除它
    expect(fs.readFileSync(stream, 'utf8')).toContain('版本二正文r5。');
  });

  it('对照组：无 IO 故障时 purge 正常清空版本流（证明上例残留是失败+不可重试所致）', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5a2');
    await assets.deleteAbilityAsset(UID, 'aa-p5a2', ACT);
    await assets.purgeAbilityAsset(UID, 'aa-p5a2', ACT);
    expect(fs.existsSync(versionsFile('aa-p5a2'))).toBe(false);
    expect(await assets.listAbilityAssetVersions(UID, 'aa-p5a2')).toEqual([]);
  });
});
