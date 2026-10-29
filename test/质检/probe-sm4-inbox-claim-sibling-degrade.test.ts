import { createNightlyCandidateFixture } from '../helpers/nightly-formation-fixture';
/** 冲突选边时 sibling 因证据不足而拒绝失败，晋升不能绕过冲突闸门。
 * 回执如实给出成功与失败计数及服务层原因，不声称其他候选已退出；
 * 待审候选与弱证据候选的真实状态都保持可核对。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-sm4-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function candidates() {
  return import('../../src/main/features/recall/candidate-service');
}

const JUDGMENT = 'Keep architecture decisions in a decision log before changing runtime boundaries.';

async function seedPair() {
  const svc = await candidates();
  // A：正常候选（rule、有证据）→ pending_review。
  const a = await createNightlyCandidateFixture('user-a', {
    judgment: JUDGMENT,
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    applicableWhen: ['Architecture review and runtime-boundary changes'],
    forbiddenWhen: ['Informal brainstorming without a decision'],
    suggestedScope: 'review,project',
    suggestedAction: 'create',
    sourceRefs: [{ kind: 'conversation', id: 'conv-sm4-a' }],
  });
  expect(a.status).toBe('pending_review');
  // B：空证据 weak_observation（同文本、不同类型）——直接落盘模拟抽取期
  // 空证据被压 weak 的存量形态（asCandidate 允许 observed/weak 携带空 refs）。
  const now = new Date().toISOString();
  const bId = 'cand-sm4-weakside1';
  const { writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
  await writeRecallJsonRecord('user-a', 'candidates', bId, {
    schemaVersion: 2, ownerId: 'user-a', id: bId,
    status: 'weak_observation', judgment: JUDGMENT,
    value: 'Use decision logs for architecture changes',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'template', suggestedScope: 'general', suggestedAction: 'create',
    sourceRefs: [], evidenceRefs: [], risk: 'low',
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  } as never);
  return { a, bId };
}

describe('冲突选边的失败计数与真实回执', () => {
  it('对照组：sibling 证据齐全（可拒）时，claim 后 sibling 确实出局', async () => {
    const svc = await candidates();
    const { a, bId } = await seedPair();
    // 把 B 补成有证据（直接改盘）→ canReject=true → reject 正常生效。
    const { readRecallJsonRecord, writeRecallJsonRecord } = await import('../../src/main/features/recall/store');
    const raw = await readRecallJsonRecord('user-a', 'candidates', bId);
    await writeRecallJsonRecord('user-a', 'candidates', bId, {
      ...raw,
      sourceRefs: [{ kind: 'conversation', id: 'conv-sm4-b' }],
      evidenceRefs: [{ kind: 'conversation', id: 'conv-sm4-b' }],
    } as never);
    const inbox = await import('../../src/main/features/cognition/inbox-adapter');
    const result = await inbox.resolveCognitionInboxItem('user-a', { id: `conflict:${a.id}`, action: 'claim' });
    expect(result.ok).toBe(true);
    const b = await svc.readRecallCandidate('user-a', bId);
    expect(b.status).toBe('rejected');
  });

  it('主用例：sibling 空证据（canReject=false，reject 抛错）时，claim 被晋升闸门拦下，回执如实计数、不再谎称 sibling 已出局', async () => {
    const svc = await candidates();
    const { a, bId } = await seedPair();
    const inbox = await import('../../src/main/features/cognition/inbox-adapter');
    // B 拒不掉（空证据能力闸）→ 同文本不同类型仍在场 → 晋升闸门拦下 A；
    // 修复后回执只陈述本轮实际做到的事：拒掉 0 条、没拒掉 1 条（带原因），
    // 绝不断言「另一条已出局」。
    const rejection = await inbox.resolveCognitionInboxItem('user-a', { id: `conflict:${a.id}`, action: 'claim' })
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'promotion_gate_rejected' });
    const message = String((rejection as Error).message);
    expect(message).not.toContain('另一条已出局');
    expect(message).toContain('拒掉 0 条');
    expect(message).toContain('没拒掉 1 条');
    // 失败原因保留服务层原文（不吞原因）。
    expect(message).toContain('candidate evidence is insufficient for review');
    // sibling 实际仍是 weak_observation 在池里；A 也未被确认——冲突未收口，
    // 但用户已被告知是谁挡住了晋升（不再是无出路的静默死结）。
    const b = await svc.readRecallCandidate('user-a', bId);
    expect(b.status).toBe('weak_observation');
    const aAfter = await svc.readRecallCandidate('user-a', a.id);
    expect(aAfter.status).toBe('pending_review');
  });
});
