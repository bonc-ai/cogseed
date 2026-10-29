import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
/** 清除级联发生 IO 失败后的可重入性；无故障路径作为对照。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 级联失败注入点：`fs.promises.rm` 模块本身。
 *
 * 为什么不在 fixture 里用 chmod 造「删不掉」——两种平台假设都立不住：
 *   POSIX：unlink 由**父目录**写位决定，文件 chmod 0444 照样能删；
 *   win32：只读属性确实挡住 unlink，但 Node 的 fs.rm 对 unlink 的 EPERM 会先
 *          `chmod(path, 0o666)` 再重试一次（lib/internal/fs/rimraf.js 的
 *          fixWinEPERM），只读文件因此被正常删掉。两者都会把用例退化成
 *          「期望 reject 实际 resolve」。
 * 也不能 spy：本仓 vitest 把 node:fs/promises 外置，`vi.spyOn(fs.promises,'rm')`
 * 拦不到 storage.ts 的 `import * as fsp from 'node:fs/promises'`。
 * 所以只在这个模块边界上包一层：首次删除指定版本流抛 EPERM，其余（含重试那次）
 * 全部转交真实实现——store 的落盘、级联、行锁与重入逻辑仍然真实执行。
 */
const streamRemovalFault = vi.hoisted(() => ({ armed: false, basename: '', hits: 0 }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (streamRemovalFault.armed && path.basename(String(target)) === streamRemovalFault.basename) {
        streamRemovalFault.armed = false;
        streamRemovalFault.hits += 1;
        throw Object.assign(
          new Error(`EPERM: operation not permitted, unlink '${String(target)}'`),
          { code: 'EPERM' },
        );
      }
      return actual.rm(target, options as never);
    },
  };
});

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
  streamRemovalFault.armed = false;
  streamRemovalFault.basename = '';
  streamRemovalFault.hits = 0;
  vi.resetModules();
});

afterEach(() => {
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
  return seedStoredAbilityAsset(UID, {
    schemaVersion: 2, ownerId: UID, id, candidateId: `cand-${id}`,
    sourceCandidateIds: [`cand-${id}`], reviewDecisionId: `rd_probe${id.slice(-6)}`.padEnd(16, 'x'),
    type: 'personal', title: `资产 ${id}`, statement: `陈述 ${id}。`,
    evidenceRefs: [{ kind: 'conversation', id: `conv-${id}` }], scope: 'general', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: now, updatedAt: now,
  }, { actor: 'user', reason: 'probe seed' });
}

const ACT = { actor: 'user' as const, reason: 'probe' };

describe('purge 级联中途失败后的可重入性', () => {
  it('级联 IO 失败后墓碑已落盘：重试可重入并清掉残留版本流', async () => {
    const assets = await loadAssets();
    await mkAsset('aa-p5a');
    // 追加第二个版本，让版本流里有正文本可被清除
    await assets.updateAbilityAsset(UID, 'aa-p5a', { statement: '版本二正文r5。', reason: 'r', actor: 'user' } as any);
    const stream = versionsFile('aa-p5a');
    expect(fs.existsSync(stream)).toBe(true);
    expect(fs.readFileSync(stream, 'utf8')).toContain('版本二正文r5。');

    // 制造级联失败：只让「删除这条版本流」的第一次调用失败（主记录目录不受影响）。
    streamRemovalFault.basename = path.basename(stream);
    streamRemovalFault.armed = true;
    await expect(assets.purgeAbilityAsset(UID, 'aa-p5a', ACT)).rejects.toThrow();
    expect(streamRemovalFault.hits, '故障注入必须命中版本流删除这一步').toBe(1);
    expect(fs.existsSync(stream), '失败后残留版本流仍在（重试才有东西可清）').toBe(true);

    // setStatus 已先行把主记录落成墓碑（正文已从主记录清空）
    const raw = JSON.parse(fs.readFileSync(assetFile('aa-p5a'), 'utf8')) as { status: string; statement: string };
    expect(raw.status).toBe('purged');
    expect(raw.statement).toBe('');

    // 应然契约（级联失败必须可重入重试）：故障解除后重试同一 purge
    // 入口——墓碑已落仍可持锁复核终态后重入级联清理，残留版本流被清空。
    const retried = await assets.purgeAbilityAsset(UID, 'aa-p5a', ACT);
    expect(retried.status).toBe('purged');
    expect(fs.existsSync(stream)).toBe(false);
    expect(await assets.listAbilityAssetVersions(UID, 'aa-p5a')).toEqual([]);

    // 重试后的墓碑不可再次变更：正文清除是终态，重放不再产生新账。
    await expect(assets.purgeAbilityAsset(UID, 'aa-p5a', ACT)).resolves.toBeTruthy();
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
