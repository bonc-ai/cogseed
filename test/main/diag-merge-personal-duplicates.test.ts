import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * 一次性诊断清扫（2026-09-20 出身收敛 · C8）：personal 生效资产语义去重。
 *
 * 背景：真机「个人画像」出现同一件事两条资产（一条出身「已确认」的旧迁移
 * 条 + 一条模型沉淀的详细条）——历史入库时语义相似度未过融合阈，遗留至今。
 * 本测试对真机数据做一次 mergeAbilityAssets 融合（短条并入详细条，走版本
 * 合并管线），修掉画像页的重复显示。
 *
 * 安全门：默认整个 describe 跳过（不进全量回归）；显式跑法——
 *   COGSEED_MERGE_DIAG=1 COGSEED_WORKSPACE_ROOT=<真数据根> \
 *   npm run test:js -- test/main/diag-merge-personal-duplicates.test.ts
 * 跑前先把 ability-assets 目录拷贝到系统临时目录做备份。
 */

const RUN = process.env.COGSEED_MERGE_DIAG === '1';

describe.skipIf(!RUN)('diag: merge duplicate personal assets (one-shot)', () => {
  it('backs up, finds semantically duplicate pairs, merges short into detailed', async () => {
    // setup-env 会无条件把 workspace root 钉到一次性 tmp（安全网）——诊断
    // 要写真数据根，须在它之后覆盖 env 并 resetModules 重导（paths 按 env
    // 解析）。备份先行，跑挂可整目录回滚。
    const realRoot = String(process.env.COGSEED_REAL_DATA_ROOT || '');
    expect(realRoot).toBeTruthy();
    process.env.COGSEED_WORKSPACE_ROOT = realRoot;
    vi.resetModules();

    const users = await import('../../src/main/features/users');
    const accounts = fs.readdirSync(realRoot).filter((n) => n.startsWith('local-account-'));
    expect(accounts.length).toBeGreaterThan(0);
    const UID = accounts[0];
    users.activateUser(UID);
    console.log('[diag] uid =', UID);

    // 备份（目录级快照，失败可整体回滚）
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const srcDir = path.dirname(recallJsonRecordPath(UID, 'ability-assets', 'placeholder'));
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-backup-'));
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, backupDir, { recursive: true });
      console.log('[diag] backup ->', backupDir);
    }

    const { listAbilityAssets, mergeAbilityAssets } = await import('../../src/main/features/recall/asset-service');
    const { embedForDedup, cosineScore, SEMANTIC_DUP_THRESHOLD } = await import('../../src/main/features/recall/similarity');

    const assets = (await listAbilityAssets(UID))
      .filter((a) => a.type === 'personal' && a.status === 'active' && !a.mergedIntoAssetId);
    console.log('[diag] active personal assets =', assets.length);

    const vectors = new Map<string, number[] | null>();
    for (const a of assets) vectors.set(a.id, await embedForDedup(UID, String(a.statement || '')));

    const merged: Array<{ source: string; target: string; score: number }> = [];
    const retired = new Set<string>();
    for (let i = 0; i < assets.length; i += 1) {
      if (retired.has(assets[i].id)) continue;
      for (let j = i + 1; j < assets.length; j += 1) {
        if (retired.has(assets[j].id)) continue;
        const va = vectors.get(assets[i].id);
        const vb = vectors.get(assets[j].id);
        if (!va || !vb) continue;
        const score = cosineScore(va, vb);
        if (score < (SEMANTIC_DUP_THRESHOLD ?? 0.85)) continue;
        // 详细条为目标（statement 更长承载更多上下文），短条为源
        const [source, target] = String(assets[i].statement || '').length >= String(assets[j].statement || '').length
          ? [assets[j], assets[i]]
          : [assets[i], assets[j]];
        console.log(`[diag] merge ${source.id} -> ${target.id} (score=${score.toFixed(3)})`);
        await mergeAbilityAssets(UID, source.id, target.id, {
          actor: 'user',
          reason: '出身收敛：语义重复的画像资产合一条（一次性清扫）',
        });
        merged.push({ source: source.id, target: target.id, score });
        retired.add(source.id);
      }
    }
    console.log('[diag] merged pairs =', merged.length, '; backup at', backupDir);

    const after = (await listAbilityAssets(UID)).filter((a) => a.type === 'personal' && a.status === 'active');
    console.log('[diag] active personal assets after =', after.length);
    expect(after.length).toBe(assets.length - merged.length);
  });
});
