/** 资产彻底清除后的审计/报告/巡检台账正文保留边界。 */
import { seedStoredAbilityAsset } from '../helpers/stored-ability-asset';
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
const UID = 'probe-r1-aud';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1aud-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ACT = { actor: 'user' as const, reason: 'probe' };

const MARKER = 'AUDIT_RESIDUE_复盘结论';
const LONG_STATEMENT = `${MARKER}这条正文超过六十个字符的上限预算，因此审计摘要只会截取它的前缀片段，其余部分应当不出现在任何保留面上。`.repeat(2);

function isolateRoot(): string {
  return path.join(tmpDir, UID, 'cloud', 'recall');
}

/** 隔离根全树 grep：任何保留面（记录/流/报告/巡检）都不得再含正文标记。 */
function grepIsolateRoot(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!fs.readFileSync(full, 'utf8').includes(needle)) continue;
      hits.push(path.relative(isolateRoot(), full));
    }
  };
  walk(isolateRoot());
  return hits;
}

describe('purge 后台账不保留正文', () => {
  it('审计/报告/巡检只留字段名、字数、动作、时间；purge 级联清掉存量引用', async () => {
    const assets = await import('../../src/main/features/recall/asset-service');
    const { listRecallJsonlRecords } = await import('../../src/main/features/recall/store');

    const now = new Date().toISOString();
    // 直接落历史记录（test-only 种子）：标题带结尾标点，便于产生规范化建议。
    await seedStoredAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id: 'aa-audit-res', candidateId: 'cand-aa-audit-res',
      sourceCandidateIds: ['cand-aa-audit-res'], reviewDecisionId: 'rd_probeauditres',
      type: 'personal', title: '审计残留观测。', statement: LONG_STATEMENT,
      evidenceRefs: [{ kind: 'conversation', id: 'conv-aa-audit-res' }], scope: 'general',
      status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud',
      version: '1', createdAt: now, updatedAt: now,
    }, ACT);

    // 新写入口径：整理报告与巡检记录不落标题/正文。
    const { runAssetCleanup } = await import('../../src/main/features/recall/cleanup-report-service');
    const report = await runAssetCleanup(UID, { trigger: 'user' });
    const inspection = await import('../../src/main/features/recall/asset-inspection-service');
    const run = await inspection.runAssetInspection(UID, { trigger: 'manual' });
    for (const entry of report.items) {
      expect(String(entry.before)).not.toContain(MARKER);
      expect(String(entry.after)).not.toContain('审计残留观测');
    }
    for (const finding of run.findings) {
      expect(String(finding.title)).not.toContain('审计残留观测');
    }

    // 存量尾巴（旧形状报告/巡检）：手工写旧口径条目，引用该资产
    // 的标题与正文（含对端引用形态：别的条目 question 里引用它的标题）。
    const { writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
    await writeRecallJsonRecord(UID, 'cleanup-reports', 'cr-legacy-1', {
      schemaVersion: 1, ownerId: UID, id: 'cr-legacy-1', trigger: 'user',
      scope: {}, round: 'rules', mode: 'report_only',
      items: [{ assetId: 'aa-audit-res', kind: 'title_normalized', status: 'uncertain',
        before: '审计残留观测。', after: '审计残留观测', reason: '旧口径正文残留' }],
      uncertain: [{ assetId: 'aa-other', title: '审计残留观测。',
        question: '与「审计残留观测。」正文相同，是否核对？', reason: '旧口径标题残留' }],
      skippedSteps: [], createdAt: now, scanned: 1,
    } as never);
    await writeRecallJsonRecord(UID, 'inspection-runs', 'ir-legacy-1', {
      schemaVersion: 1, ownerId: UID, id: 'ir-legacy-1', trigger: 'manual',
      scope: { statuses: ['active'] },
      findings: [{ key: 'outdated:aa-audit-res', category: 'outdated', assetIds: ['aa-audit-res'],
        title: '审计残留观测。', detail: '超过 180 天没有更新过。' }],
      scanned: 1, startedAt: now,
    } as never);
    expect(grepIsolateRoot('审计残留观测').length).toBeGreaterThan(0); // 残留现场确实在盘上

    // 走真实生命周期：delete → purge（到期清扫同款路径）
    await assets.deleteAbilityAsset(UID, 'aa-audit-res', ACT);
    const purged = await assets.purgeAbilityAsset(UID, 'aa-audit-res', ACT);
    // 对照组：主记录正文确实清空
    expect(purged.statement).toBe('');
    expect((await assets.readAbilityAsset(UID, 'aa-audit-res')).statement).toBe('');

    // 应然契约①：审计行不再含正文前缀——摘要只剩字段名与字数。
    const audit = await listRecallJsonlRecords(UID, 'ability-asset-audit', 'aa-audit-res', 0);
    expect(audit.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(audit);
    expect(dumped).not.toContain(MARKER);
    expect(dumped).not.toContain('其余部分应当不出现在任何保留面上');
    const purgeRow = audit.find((row) => (row as { action?: string }).action === 'purged');
    expect(purgeRow).toBeDefined();
    expect(String((purgeRow as unknown as { before?: string }).before)).toMatch(/statement=\d+ 字/);

    // 应然契约②：purge 级联把存量报告/巡检里的正文/标题引用清成不可识别形式。
    // 隔离根全树 grep 不到正文标记（验收口径）。
    expect(grepIsolateRoot(MARKER)).toEqual([]);
    expect(grepIsolateRoot('审计残留观测')).toEqual([]);

    // 处置状态不因清除丢账：旧报告条目仍在（结构保留），只是内容不可识别。
    const { readCleanupReport } = await import('../../src/main/features/recall/cleanup-report-service');
    const legacy = await readCleanupReport(UID, 'cr-legacy-1');
    expect(legacy?.items[0].assetId).toBe('aa-audit-res');
    expect(legacy?.items[0].before).toBe('（内容已彻底清除）');
    const legacyRun = await inspection.readInspectionRun(UID, 'ir-legacy-1');
    expect(legacyRun?.findings[0].title).toBe('（内容已彻底清除）');
  });
});
