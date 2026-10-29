/** Real nightly source proof, human promotion, review/version binding and
 * prompt/feedback/omission persistence. No model, permission or review mocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNightlyCandidateInput, markFixtureCaptureReady } from '../../../helpers/nightly-formation-fixture';
import type { SaveRecallCandidateInput } from '../../../../src/main/features/recall/candidate-service';

const uid = 'standing-budget-user';
const task = '复杂技术问题：说明数据库连接池的排查思路。';
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-standing-budget-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '0');
  vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser(uid);
  const { migrateLegacyCognition } = await import('../../../../src/main/features/cognition_migration');
  expect((await migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
});
afterEach(async () => {
  const { closeEmbedder } = await import('../../../../src/main/features/kb_embed');
  closeEmbedder();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function promoted(input: Pick<SaveRecallCandidateInput, 'judgment' | 'summary' | 'contentCategory'>
  & Partial<SaveRecallCandidateInput>) {
  const prepared = await prepareNightlyCandidateInput(uid, {
    value: '保留用户明确说明的对象与边界，供后续相关任务复用。',
    suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create',
    sourceRefs: [], rawStatement: true, ...input,
  });
  const store = await import('../../../../src/main/features/recall/store');
  const capture = (await store.readRecallJsonRecord(uid, 'captures', prepared.captureProvenance!.captureId))!;
  const messageId = prepared.captureProvenance!.messageIds[0]!;
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageFile(uid, String(capture.conversationId));
  const message = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  const body = input.judgment;
  const sourceText = [body, ...(input.applicableWhen || []), ...(input.forbiddenWhen || [])].join('\n');
  fs.writeFileSync(file, JSON.stringify({ ...message, text: sourceText }) + '\n');
  const summaryModule = await import('../../../../src/main/features/recall/capture-context-summary');
  const { captureSummaryDecisionDigest } = await import('../../../../src/main/features/recall/capture-provenance');
  const messages = [{ id: messageId, role: 'user' as const, text: sourceText, discovery: true }];
  const sourceSliceSize = Math.floor((100_000 - 1_000) / 8);
  const segmentCount = Math.ceil(sourceText.length / sourceSliceSize);
  const summary = summaryModule.validateCaptureContextSummary({
    sourceDigest: summaryModule.captureContextSourceDigest(messages),
    completedAt: prepared.captureProvenance!.extractionCompletedAt,
    topics: [{ title: '隔离预算验收用户原文', content: body, conditions: [], unresolved: [],
      attribution: 'user_requirement', evidence: [{ messageId, role: 'user', quote: body, start: 0, end: body.length }] }],
    coverage: { messageCount: 1, sourceChars: sourceText.length, segmentCount,
      processedSegmentIds: Array.from({ length: segmentCount }, (_, i) => `m0:${i * sourceSliceSize}`), maxInputChars: 100_000 },
  }, messages);
  prepared.captureProvenance!.valueJudgment = {
    ...prepared.captureProvenance!.valueJudgment,
    evidence: prepared.captureProvenance!.valueJudgment.evidence.map(row => ({ ...row, quote: body })),
    summaryDigest: captureSummaryDecisionDigest(summary),
  };
  for (const refs of [prepared.sourceRefs, prepared.evidenceRefs]) {
    for (const ref of refs || []) if (ref.excerpt) ref.excerpt = body;
  }
  await store.writeRecallJsonRecord(uid, 'captures', capture.id, {
    ...capture, contextSummary: summary, valueJudgment: prepared.captureProvenance!.valueJudgment,
  });
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(uid, prepared);
  await markFixtureCaptureReady(uid, candidate);
  // Each synthetic item is deliberately distinct; the human explicitly creates
  // separate budget fixtures even if the similarity heuristic sees overlap.
  const { asset } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user', forceCreateSimilar: true });
  expect(asset.statement).toBe(body);
  if (input.contentCategory === 'preference') {
    const { hasUserAuthorizedStandingPreference } = await import('../../../../src/main/features/recall/standing-preference');
    expect(await hasUserAuthorizedStandingPreference(uid, asset)).toBe(true);
  }
  return asset;
}

async function longThenShortFixtures() {
  const short = await promoted({ judgment: '以后解释复杂技术问题时，最后简要列出仍待确认的信息。',
    summary: '列出待确认信息', contentCategory: 'preference' });
  const conditions = Array.from({ length: 32 }, (_, i) => `独立适用情境${i}：` + '仅针对用户声明的具体对象，保留完整前提与范围。'.repeat(19));
  const exceptions = Array.from({ length: 32 }, (_, i) => `独立排除情境${i}：` + '不要把局部约束扩大到其它对象，资料缺失时保持待核。'.repeat(18));
  const long = await promoted({ judgment: '以后解释复杂技术问题，先清楚说明前提；逐项检查保存的全部适用条件和例外。',
    summary: '完整前提与例外', contentCategory: 'preference', applicableWhen: conditions, forbiddenWhen: exceptions });
  expect(long.applicableWhen).toEqual(conditions);
  expect(long.forbiddenWhen).toEqual(exceptions);
  const { listAbilityAssets } = await import('../../../../src/main/features/recall/asset-service');
  const ordered = await listAbilityAssets(uid);
  expect(ordered.findIndex(row => row.id === long.id)).toBeLessThan(ordered.findIndex(row => row.id === short.id));
  expect(JSON.stringify([conditions, exceptions]).length).toBeGreaterThan(14_000);
  return { long, short, conditions, exceptions };
}

describe('standing preference shares the formal prompt budget', () => {
  it('selects 12 equal-time human-confirmed preferences stably and audits the overflow version', async () => {
    const preferences = [];
    for (let i = 0; i < 13; i++) preferences.push(await promoted({
      judgment: `以后进行技术审阅，遇到独立情境${i}时，请明确列出待核对象${i}，便于后续确认。`,
      summary: `情境${i}的审阅偏好`, contentCategory: 'preference',
    }));
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    // Equal timestamps exercise ordering only. Keep every source, review,
    // candidate, version, body and permission field from real user promotion.
    for (const asset of preferences) await updateRecallJsonRecord(uid, 'ability-assets', asset.id, current => {
      if (!current) throw new Error('promoted preference missing');
      return { ...current, updatedAt: '2026-10-12T00:00:00.000Z' };
    });
    const { readAbilityAsset } = await import('../../../../src/main/features/recall/asset-service');
    const { hasUserAuthorizedStandingPreference } = await import('../../../../src/main/features/recall/standing-preference');
    for (const asset of preferences) expect(await hasUserAuthorizedStandingPreference(uid, await readAbilityAsset(uid, asset.id))).toBe(true);
    const ordered = preferences.slice().sort((a, b) => a.id.localeCompare(b.id));
    const expectedIds = ordered.slice(0, 12).map(row => row.id);
    const overflow = ordered[12]!;
    const { buildRecallTurnPromptContext } = await import('../../../../src/main/features/recall/prompt-injection');
    const input = { cid: 'cid-budget-thirteen', taskRunId: 'turn-budget-thirteen', taskText: task,
      agentId: 'commander', conversationKind: 'normal' };
    const next = await buildRecallTurnPromptContext(uid, input);
    expect(next.citations.map(row => row.assetId)).toEqual(expectedIds);
    expect(next.promptBlock).not.toContain(overflow.statement);
    const { readContextProjection } = await import('../../../../src/main/features/recall/context-projection');
    const projection = await readContextProjection(uid, next.citations[0]!.projectionId);
    expect(projection).toMatchObject({ authorization: 'not_required', assetIds: expectedIds,
      omittedRefs: expect.arrayContaining([{ assetId: overflow.id, reason: 'prompt_budget' }]) });
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const omitted = (await listInjectionReceipts(uid, input.taskRunId)).filter(row => row.assetId === overflow.id);
    expect(omitted).toEqual([expect.objectContaining({ projectionId: projection.id, assetVersion: overflow.version,
      status: 'omitted', reason: 'prompt_budget', boundary: 'real', channel: 'projection' })]);
    const repeated = await buildRecallTurnPromptContext(uid, input);
    expect(repeated.citations.map(row => row.assetId)).toEqual(expectedIds);
    expect((await listInjectionReceipts(uid, input.taskRunId)).filter(row => row.assetId === overflow.id)).toEqual(omitted);
  });

  it('keeps 12 committed citations within the global count and accepts real message feedback', async () => {
    const committedAssets = [];
    for (let i = 0; i < 12; i++) committedAssets.push(await promoted({
      judgment: `隔离项目${i}的交付验收由负责人${i}确认签字，后续准备这个项目的验收材料时使用此信息。`,
      summary: `项目${i}验收负责人`, contentCategory: 'unclassified',
    }));
    const standing = await promoted({ judgment: '以后回答复杂技术问题，先给结论，再说明关键依据。',
      summary: '复杂技术回答顺序', contentCategory: 'preference' });
    const { previewContextProjection } = await import('../../../../src/main/features/recall/context-projection');
    const projection = await previewContextProjection(uid, { taskRunId: 'turn-budget-twelve', purpose: 'user_pinned',
      authorization: 'user_confirmed', confirm: true, conversationId: 'cid-budget-twelve',
      explicitAssetIds: committedAssets.map(asset => asset.id) });
    expect(projection.assetIds).toHaveLength(12);
    const { buildRecallTurnPromptContext } = await import('../../../../src/main/features/recall/prompt-injection');
    const next = await buildRecallTurnPromptContext(uid, { cid: 'cid-budget-twelve', taskRunId: 'turn-budget-twelve',
      taskText: task, conversationKind: 'normal', agentId: 'commander', committedProjectionId: projection.id });
    expect(next.citations.map(row => row.assetId).sort()).toEqual(committedAssets.map(row => row.id).sort());
    expect(next.citations).toHaveLength(12);
    expect(next.promptBlock.length).toBeLessThanOrEqual(14_000);
    expect(next.promptBlock).not.toContain(standing.statement);
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const omitted = (await listInjectionReceipts(uid, 'turn-budget-twelve')).find(row => row.assetId === standing.id);
    expect(omitted).toMatchObject({ assetVersion: standing.version, status: 'omitted', reason: 'prompt_budget' });
    const { readContextProjection } = await import('../../../../src/main/features/recall/context-projection');
    expect((await readContextProjection(uid, omitted!.projectionId!)).authorization).toBe('not_required');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    await appendJsonlAtomic(conversationMessageFile(uid, 'cid-budget-twelve'), {
      id: 'message-budget-twelve', from: 'commander', text: '已按确认的项目资料整理。', turn_id: 'turn-budget-twelve',
      recall_citations: next.citations.map(row => ({ asset_id: row.assetId, title: row.title, type: row.type,
        version: row.version, scope: row.scope, projection_id: row.projectionId, match_method: row.matchMethod })),
    });
    const { recordRecallMessageFeedback } = await import('../../../../src/main/features/recall/usage-feedback-service');
    const feedback = await recordRecallMessageFeedback(uid, {
      cid: 'cid-budget-twelve', messageId: 'message-budget-twelve', feedback: 'positive',
    });
    expect(feedback).toMatchObject({ citationCount: 12, recordedCount: 12 });
  });

  it('omits an oversized complete standing preference and still includes a later short preference', async () => {
    const { long, short } = await longThenShortFixtures();
    const { buildRecallTurnPromptContext } = await import('../../../../src/main/features/recall/prompt-injection');
    const next = await buildRecallTurnPromptContext(uid, { cid: 'cid-budget-long', taskRunId: 'turn-budget-long',
      taskText: task, conversationKind: 'normal', agentId: 'commander' });
    expect(next.citations).toEqual([expect.objectContaining({ assetId: short.id, version: short.version, matchMethod: 'standing_preference' })]);
    expect(next.promptBlock).toContain(short.statement);
    expect(next.promptBlock).not.toContain(long.statement);
    expect(next.promptBlock.length).toBeLessThanOrEqual(14_000);
    expect(next.authorizedAssetsBlock).toContain(short.statement);
    expect(next.authorizedAssetsBlock).not.toContain(long.statement);
  });

  it('persists a safe real omission for a not_required standing projection without inventing injection', async () => {
    const { long, short } = await longThenShortFixtures();
    const { buildRecallTurnPromptContext } = await import('../../../../src/main/features/recall/prompt-injection');
    const input = { cid: 'cid-budget-audit', taskRunId: 'turn-budget-audit', taskText: task,
      conversationKind: 'normal', agentId: 'commander' };
    const next = await buildRecallTurnPromptContext(uid, input);
    const { readContextProjection } = await import('../../../../src/main/features/recall/context-projection');
    const projection = await readContextProjection(uid, next.citations.find(row => row.assetId === short.id)!.projectionId);
    expect(projection).toMatchObject({ authorization: 'not_required', status: 'confirmed' });
    const { listInjectionReceipts } = await import('../../../../src/main/features/recall/injection-receipt');
    const receipt = (await listInjectionReceipts(uid, input.taskRunId)).find(row => row.assetId === long.id);
    expect(receipt).toMatchObject({ assetId: long.id, assetVersion: long.version, projectionId: projection.id,
      taskRunId: input.taskRunId, boundary: 'real', channel: 'projection', status: 'omitted', reason: 'prompt_budget' });
    const { safeId } = await import('../../../../src/main/storage');
    expect(safeId(receipt!.assetId)).toBe(true);
    expect(safeId(receipt!.projectionId!)).toBe(true);
    expect(receipt!.assetVersion).toMatch(/^\d+$/);
    expect(receipt!.id).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(receipt).not.toHaveProperty('statement');
    expect(JSON.stringify(receipt)).not.toContain(long.statement);
    await buildRecallTurnPromptContext(uid, input);
    expect((await listInjectionReceipts(uid, input.taskRunId)).filter(row => row.assetId === long.id)).toEqual([receipt]);
  });
});
