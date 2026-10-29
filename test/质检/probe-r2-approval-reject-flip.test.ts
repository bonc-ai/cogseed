import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/** Concurrent approval/rejection must preserve the winning terminal decision.
 * Hold the asset write lock so a queued confirmation overlaps a rejection.
 * The confirmation must return a conflict and compensate any applied content,
 * preserving version history, the rejected proposal and an accurate audit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let previousRoot: string | undefined;
const RULE_BOUNDARY = { applicableWhen: ['performing governed work'], forbiddenWhen: ['outside the governed scope'] };

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r2-apr-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'probe-r2-apr';

async function modules() {
  const [candidates, assets, approval] = await Promise.all([
    import('../../src/main/features/recall/candidate-service'),
    import('../../src/main/features/recall/asset-service'),
    import('../../src/main/features/recall/asset-approval-service'),
  ]);
  return { candidates, assets, approval };
}

async function seedAsset() {
  const { candidates } = await modules();
  const candidate = await createNightlyCandidateFixture(UID, {
    judgment: '发布前必须核对回滚方案。',
    summary: '审批竞态基线样本',
    suggestedType: 'rule', ...RULE_BOUNDARY, suggestedScope: 'architecture',
    sourceRefs: [{ kind: 'execution', id: 'exec-apr-race' }],
  });
  return (await candidates.promoteRecallCandidate(UID, candidate.id, { actor: 'user' })).asset;
}

async function proposeChange(assetId: string, statement: string) {
  const { approval } = await modules();
  return approval.createAssetChangeProposal(UID, {
    assetId,
    baselineVersion: '1',
    fields: ['statement'],
    payload: { statement },
    before: 'statement=旧',
    after: `statement=${statement.length} 字`,
    reason: '探针：并发拒绝翻转',
  });
}

describe('探针 r2 › 审批提议终态预检在锁外：reject 被 confirm 交错翻转', () => {
  it('对照组：串行 reject → confirm 时预检生效，内容不应用、提议保持 rejected', async () => {
    const { assets, approval } = await modules();
    const asset = await seedAsset();
    const proposalId = (await proposeChange(asset.id, '被拒绝的提议内容。')).proposal.id;
    const rejected = await approval.decideAssetChangeProposal(UID, proposalId, 'reject');
    expect(rejected.ok).toBe(true);
    expect(rejected.state).toBe('rejected');
    const late = await approval.decideAssetChangeProposal(UID, proposalId, 'confirm');
    expect(late.ok).toBe(false);
    expect(late.state).toBe('rejected');
    expect((await assets.readAbilityAsset(UID, asset.id)).statement).toBe(asset.statement);
    expect((await assets.readAbilityAsset(UID, asset.id)).version).toBe('1');
  });

  it('confirm 预检后排队期间 reject 落盘 → confirm 失败回执、被拒内容按提议前取值回滚、终态保持 rejected', async () => {
    const { assets, approval } = await modules();
    const asset = await seedAsset();
    const proposalId = (await proposeChange(asset.id, '被拒绝的提议内容。')).proposal.id;
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const { fileEditLock } = await import('../../src/main/util/locks');
    const assetPath = recallJsonRecordPath(UID, 'ability-assets', asset.id);

    // 确定性时序：先持资产文件锁，confirm 的 updateAbilityAsset 在锁上排队
    // （锁外预检已通过，真正的拦截靠锁内 CAS + 补偿回滚）。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = fileEditLock(assetPath).runExclusive(() => gate);
    await new Promise((r) => setTimeout(r, 5));

    const confirmP = approval.decideAssetChangeProposal(UID, proposalId, 'confirm');
    await new Promise((r) => setTimeout(r, 25));

    // 持锁期间用户在另一张卡/窗口点了拒绝。审批账本与资产写入共用本用户的
    // cognition transition，而 confirm 排队等资产锁时正握着它，所以 reject 的
    // 落盘会停在 transition 上。必须先放闸让 confirm 已通过的写入排空，reject
    // 才能在「资产已改、提议终态未落」的同一窗口里赢下——随后仍走补偿回滚，
    // 这正是本条探针要覆盖的路径；断言不因放闸顺序而放宽。
    const rejectP = approval.decideAssetChangeProposal(UID, proposalId, 'reject');
    await new Promise((r) => setTimeout(r, 25));
    release();
    await holder;
    const rejected = await rejectP;
    expect(rejected.ok).toBe(true);
    expect(rejected.state).toBe('rejected');

    const confirmed = await confirmP;

    // 写入前读到拒绝终态：失败回执，正文留在拒绝前，不再先写再回滚。
    expect(confirmed.ok).toBe(false);
    expect(confirmed.state).toBe('rejected');
    expect(confirmed.appliedVersion).toBeUndefined();
    const after = await assets.readAbilityAsset(UID, asset.id);
    expect(after.statement).toBe(asset.statement);
    expect(after.version).toBe('1');
    const final = await approval.readAssetChangeProposal(UID, proposalId);
    expect(final?.state).toBe('rejected');
    const audit = await assets.listAbilityAssetAudit(UID, asset.id);
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('approval_rejected');
    expect(actions).not.toContain('approval_confirmed');
  });
});
