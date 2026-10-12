/**
 * 探针 r1（红队-越权与状态，新一轮 r1）：purge 保留的审计流携带正文前缀摘要。
 *
 * 发现（读码）：
 *  - purgeAbilityAsset 保留审计流，理由注释（asset-service.ts:1385-1386）自称
 *    「它只有动作名和时间戳，属于规范允许保留的不可识别最小项」；
 *  - 但 appendAudit 落的 before/after 摘要（asset-service.ts:481-482）来自
 *    summarizeAuditChange：statement 是 AUDIT_BODY_FIELDS（:357），摘要格式
 *    `N 字·「正文前 60 字…」`（AUDIT_BODY_PREFIX_CHARS=60，:381-384，短正文整段进）；
 *    title 走 clipAuditText 80 字。
 *  - 后果：purge 后审计行（ability-asset-audit JSONL，渲染层 timeline 在读，
 *    :468 注释）仍能读回正文开头——与「仅保留不可识别的审计最小项」的自我
 *    声明矛盾。删除语义 vs 审计留痕如何取舍需拍板，故本探针只实证现状。
 * 风格对齐 probe-r1-purge-tombstone-residue.test.ts（同域探针）。
 * 2026-09-30 r1 收尾（记账员）：对应待议 P-r1-8（specs/010 N-11 已裁定审计
 * 留痕有意保留，修法=改注释对齐裁定 vs 翻案脱敏需推翻 N-11）→ it.skip。
 * 断言锁定的「摘要含正文前 60 字」是现状，拍板后按所选矛盾面处置。
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

describe('probe r1 › purge 保留的审计流含正文前缀（待议 P-r1-8，拍板前 skip）', () => {
  it.skip('delete→purge 后审计行 before 摘要仍含正文前 60 字（对照组：主记录 statement 已清空）', async () => {
    const { createAbilityAsset, deleteAbilityAsset, purgeAbilityAsset, readAbilityAsset } =
      await import('../../src/main/features/recall/asset-service');
    const { listRecallJsonlRecords } = await import('../../src/main/features/recall/store');

    const now = new Date().toISOString();
    await createAbilityAsset(UID, {
      schemaVersion: 2, ownerId: UID, id: 'aa-audit-res', candidateId: 'cand-aa-audit-res',
      sourceCandidateIds: ['cand-aa-audit-res'], reviewDecisionId: 'rd_probeauditres',
      type: 'personal', title: '审计残留观测', statement: LONG_STATEMENT,
      evidenceRefs: [{ kind: 'conversation', id: 'conv-aa-audit-res' }], scope: 'general',
      status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud',
      version: '1', createdAt: now, updatedAt: now,
    }, ACT);

    await deleteAbilityAsset(UID, 'aa-audit-res', ACT);
    const purged = await purgeAbilityAsset(UID, 'aa-audit-res', ACT);
    // 对照组：主记录正文确实清空
    expect(purged.statement).toBe('');
    expect((await readAbilityAsset(UID, 'aa-audit-res')).statement).toBe('');

    // 发现主体：purge 写下的审计行 before 摘要含正文前缀（前 60 字）
    const audit = await listRecallJsonlRecords(UID, 'ability-asset-audit', 'aa-audit-res', 0);
    expect(Array.isArray(audit)).toBe(true);
    expect(audit.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(audit);
    // MARKER 在正文开头 60 字内，必然出现在 before 摘要里
    expect(dumped).toContain(MARKER);
    // 正文中段（超出 60 字前缀的部分）不应出现在审计流——证明确实是前缀截断而非全文
    expect(dumped).not.toContain('其余部分应当不出现在任何保留面上。');
  });
});
