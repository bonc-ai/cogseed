import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/chats', () => ({ getConversation: async () => ({ conversation_id: 'cid-a' }) }));
const runModel = vi.fn();
const snapshot = vi.fn();
const current = vi.fn();
const projection = vi.fn();
const readable = vi.fn();
const hostTask = vi.fn();
const hostRequirement = vi.fn();
const submitClaim = vi.fn();
vi.mock('../../../../src/main/features/kstar/requirement-store', () => ({ readKstarTask: (...args: unknown[]) => hostTask(...args), readKstarRequirement: (...args: unknown[]) => hostRequirement(...args) }));
vi.mock('../../../../src/main/features/group_chat', () => ({ _readSubmitClaim: (...args: unknown[]) => submitClaim(...args) }));
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: (...args: unknown[]) => runModel(...args) }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAssetVersionSnapshot: (...args: unknown[]) => snapshot(...args), readAbilityAsset: (...args: unknown[]) => current(...args) }));
vi.mock('../../../../src/main/features/recall/context-projection', () => ({ readContextProjection: (...args: unknown[]) => projection(...args) }));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: (...args: unknown[]) => readable(...args) }));
let root: string;
let previous: string | undefined;
const output = '结论：采用隔离测试数据。\n\n原因：它能保留你的现有认知和来源。';
const task = '请解释为什么测试需要隔离数据。';
const asset = { assetId: 'aa-pref', version: '1', content: '解释复杂问题，先给结论，再讲原因。', applicableWhen: [], forbiddenWhen: [] };
const good = { assetId: 'aa-pref', version: '1', status: 'complied', outputEvidence: { quote: '结论：采用隔离测试数据。', start: 0, end: 13 } };

beforeEach(async () => {
  vi.resetModules(); runModel.mockReset(); snapshot.mockReset(); current.mockReset(); projection.mockReset(); readable.mockReset();
  hostTask.mockReset(); hostRequirement.mockReset(); submitClaim.mockReset();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-output-check-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  snapshot.mockResolvedValue({ type: 'cognition', statement: asset.content, contentCategory: 'preference', applicableWhen: [], forbiddenWhen: [], evidenceRefs: [] });
  current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', version: '1', evidenceRefs: [] });
  projection.mockResolvedValue({ status: 'confirmed', taskRunId: 'turn-a', conversationId: 'cid-a', purpose: 'general', assetIds: ['aa-pref'], assetVersions: { 'aa-pref': '1' } });
  readable.mockImplementation(async (_user, assets) => assets);
  // Compute coordinates from the fixture, avoiding assumptions about UTF-16.
  good.outputEvidence.end = good.outputEvidence.quote.length;
  runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [good] }), meta: {} } });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(root, { recursive: true, force: true });
});
async function supplied(overrides: Record<string, unknown> = {}, finalText = output) {
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile('user-a', 'cid-a');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, { id: 'message-a', from: 'commander', text: finalText, turn_id: 'turn-a' });
  const { recordInjectionReceipt } = await import('../../../../src/main/features/recall/injection-receipt');
  await recordInjectionReceipt('user-a', { assetId: 'aa-pref', assetVersion: '1', taskRunId: 'turn-a', messageId: 'message-a',
    projectionId: 'projection-a', channel: 'projection', boundary: 'real', status: 'injected', ...overrides });
}
const input = { cid: 'cid-a', taskRunId: 'turn-a', messageId: 'message-a', taskText: task };

describe('model-assisted cognition compliance observations', () => {
  it('can independently establish actual use after a literal agent quote failed without repairing that quote', async () => {
    await supplied();
    const { finalizeAssetUsageClaims } = await import('../../../../src/main/features/recall/asset-usage-claim');
    const escapedClaim = { assetId: asset.assetId, assetVersion: asset.version, outputExcerpt: output.replace(/\n/g, '\\n') };
    const attempt = { cid: input.cid, taskRunId: input.taskRunId, messageId: input.messageId, claims: [escapedClaim] };
    expect(await finalizeAssetUsageClaims('user-a', attempt)).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'agent_reported', reportFailure: 'quote_not_found' })]);
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }] });
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', observationMethod: 'model_assisted' })]);
    await finalizeAssetUsageClaims('user-a', attempt);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', observationMethod: 'model_assisted' })]);
    expect(escapedClaim.outputExcerpt).toBe(output.replace(/\n/g, '\\n'));
    expect(runModel).toHaveBeenCalledTimes(1);
  });
  async function suppliedHostTask() {
    await supplied();
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    const file = conversationMessageFile('user-a', 'cid-a');
    await appendJsonlAtomic(file, { id: 'source-a', from: 'user', text: task, action_request_id: 'request-a', run_id: 'run-a' });
    await appendJsonlAtomic(file, { id: 'message-a', from: 'commander', text: output, turn_id: 'turn-a', run_id: 'run-a' });
    projection.mockResolvedValue({ id: 'projection-a', status: 'confirmed', taskRunId: 'host-task-a', conversationId: 'cid-a',
      purpose: 'general', assetIds: ['aa-pref'], assetVersions: { 'aa-pref': '1' } });
    hostTask.mockResolvedValue({ id: 'host-task-a', conversationId: 'cid-a', requirementIds: ['requirement-a'] });
    hostRequirement.mockResolvedValue({ taskId: 'host-task-a', conversationId: 'cid-a', projectionId: 'projection-a', projectionIds: ['projection-a'], userMessageIds: ['source-a'] });
    submitClaim.mockResolvedValue({ state: 'accepted', message_id: 'source-a', run_id: 'run-a', recipient_ids: ['commander'], dispatch_turn_ids: { commander: 'turn-a' } });
  }
  it('checks a governed task projection only through its requirement source and accepted exact actor turn', async () => {
    await suppliedHostTask();
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }] });
    expect(submitClaim).toHaveBeenCalledWith('user-a', 'cid-a', 'request-a');
    expect(runModel).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-binding', 'old-turn', 'wrong-task'])('keeps governed adoption unknown for %s even in the same conversation', async fault => {
    await suppliedHostTask();
    if (fault === 'missing-binding') submitClaim.mockResolvedValue(null);
    if (fault === 'old-turn') submitClaim.mockResolvedValue({ state: 'accepted', message_id: 'source-a', run_id: 'run-a', recipient_ids: ['commander'], dispatch_turn_ids: { commander: 'old-turn' } });
    if (fault === 'wrong-task') hostRequirement.mockResolvedValue({ taskId: 'another-task', conversationId: 'cid-a', projectionId: 'projection-a', projectionIds: ['projection-a'], userMessageIds: ['source-a'] });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
    expect(await (await import('../../../../src/main/features/recall/asset-usage-receipt')).listAssetUsageReceipts('user-a')).toEqual([]);
  });
  it('rejects reply-only compliance when a produced file is the deliverable', async () => {
    const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    setWorkspacePath('user-a', root);
    const file = path.join(root, 'bad-report.md');
    await fs.writeFile(file, '文件没有给出结论和原因。');
    await supplied();
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    await appendJsonlAtomic(conversationMessageFile('user-a', 'cid-a'), { id: 'message-a', from: 'commander', text: output, turn_id: 'turn-a', produced: [file] });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
  });
  it('checks the actual persisted file rather than the reply claiming completion, in the same model call', async () => {
    const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    expect(setWorkspacePath('user-a', root).ok).toBe(true);
    const file = path.join(root, 'report.md');
    await fs.writeFile(file, '实际文件只有背景说明，缺少要求的结论和依据。');
    await supplied({}, '文件已完整生成，要求已经全部满足。');
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    await appendJsonlAtomic(conversationMessageFile('user-a', 'cid-a'), { id: 'message-a', from: 'commander', text: '文件已完整生成，要求已经全部满足。', turn_id: 'turn-a', produced: [file] });
    runModel.mockImplementation(async (_user, request) => {
      const payload = JSON.parse(request.message);
      expect(payload.output).toContain('缺少要求的结论和依据');
      return { result: { text: JSON.stringify({ checks: [{ assetId: asset.assetId, version: '1', status: 'not_complied',
        outputEvidence: { quote: '实际文件只有背景说明，缺少要求的结论和依据。' } }] }), meta: {} } };
    });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const receipt = await checkPersistedCognitionOutput('user-a', input);
    expect(receipt).toMatchObject({ modelCompleted: true, resultCoverage: { complete: true, readableFiles: 1 }, checks: [{ status: 'not_complied' }] });
    expect(runModel).toHaveBeenCalledTimes(1);
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'model_assisted' })]);
  });
  it('holds actual use unverified for an unsupported final file without an additional model call', async () => {
    await supplied();
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    await appendJsonlAtomic(conversationMessageFile('user-a', 'cid-a'), { id: 'message-a', from: 'commander', text: output, turn_id: 'turn-a', produced: [path.join(root, 'report.pdf')] });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, resultCoverage: { complete: false }, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'result_coverage' })]);
  });
  it('does not adopt a file that changed while its complete result was being checked', async () => {
    const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace'); setWorkspacePath('user-a', root);
    const file = path.join(root, 'changed.md'); await fs.writeFile(file, '原始完整结论与依据。'); await supplied();
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    await appendJsonlAtomic(conversationMessageFile('user-a', 'cid-a'), { id: 'message-a', from: 'commander', text: output, turn_id: 'turn-a', produced: [file] });
    runModel.mockImplementation(async () => { await fs.writeFile(file, '用户在检查期间更改了正文。'); return { result: { text: JSON.stringify({ checks: [good] }), meta: {} } }; });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
  });
  it('checks the persisted final output and injected version without claiming an effectiveness proof', async () => {
    await supplied();
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const result = await checkPersistedCognitionOutput('user-a', input);
    expect(result).toMatchObject({ modelCompleted: true, method: 'model_assisted', checks: [{ assetId: 'aa-pref', version: '1', status: 'complied' }] });
    const payload = JSON.parse(runModel.mock.calls[0][1].message);
    expect(payload).toMatchObject({ task, output, assets: [asset] });
    expect(runModel.mock.calls[0][1].responseFormat).toBe('json_object');
    expect(snapshot).toHaveBeenCalledWith('user-a', 'aa-pref', '1');
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', reason: expect.stringContaining('not an effectiveness proof') })]);
    expect(JSON.stringify(result)).not.toContain(output);
    await checkPersistedCognitionOutput('user-a', input);
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it.each([{ assetVersion: '2' }, { messageId: 'other-message' }, { taskRunId: 'other-turn' }, { status: 'omitted' }, { boundary: 'test-double' }])('holds invalid/mismatched supply as unverified: %j', async overrides => {
    await supplied(overrides);
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const result = await checkPersistedCognitionOutput('user-a', input);
    if (overrides.assetVersion) {
      expect(result?.modelCompleted).toBe(false);
      expect(result?.checks[0]).toMatchObject({ version: '2', status: 'unknown' });
      expect(runModel).not.toHaveBeenCalled();
    } else { expect(result).toBeUndefined(); expect(runModel).not.toHaveBeenCalled(); }
  });

  it('rejects fabricated evidence, missing identities and later asset versions', async () => {
    const { parseCognitionOutputChecks } = await import('../../../../src/main/features/recall/cognition-output-check');
    for (const checks of [[], [good, good], [{ ...good, version: '2' }], [{ ...good, outputEvidence: { quote: '假的证据', start: 0, end: 4 } }], [{ ...good, outputEvidence: undefined }]]) {
      expect(() => parseCognitionOutputChecks(JSON.stringify({ checks }), [asset], task, output)).toThrow();
    }
  });

  it('resolves unique quote-only evidence and rejects ambiguous passages without coordinates', async () => {
    const { parseCognitionOutputChecks } = await import('../../../../src/main/features/recall/cognition-output-check');
    const quote = good.outputEvidence.quote;
    expect(parseCognitionOutputChecks(JSON.stringify({ checks: [{ ...good, outputEvidence: { quote } }] }), [asset], task, output)[0].outputEvidence)
      .toEqual({ start: 0, end: quote.length });
    expect(() => parseCognitionOutputChecks(JSON.stringify({ checks: [{ ...good, outputEvidence: { quote } }] }), [asset], task, quote + quote)).toThrow('ambiguous');
  });

  it('normalizes distinct grounded clause observations without inventing identities or resolving conflicting verdicts', async () => {
    const { parseCognitionOutputChecks } = await import('../../../../src/main/features/recall/cognition-output-check');
    const later = { ...good, outputEvidence: { quote: '原因：它能保留你的现有认知和来源。' } };
    expect(parseCognitionOutputChecks(JSON.stringify({ checks: [later, good] }), [asset], task, output))
      .toEqual([{ assetId: asset.assetId, version: asset.version, status: 'complied', outputEvidence: { start: 0, end: good.outputEvidence.quote.length } }]);
    for (const rows of [
      [good, { ...later, status: 'not_complied' }],
      [good, { ...later, version: '2' }],
      [good, { ...later, assetId: 'invented' }],
      [good, { ...later, outputEvidence: { quote: '未出现的原文' } }],
    ]) expect(() => parseCognitionOutputChecks(JSON.stringify({ checks: rows }), [asset], task, output)).toThrow();
    expect(() => parseCognitionOutputChecks(JSON.stringify({ checks: [good, later] }),
      [asset, { ...asset, assetId: 'aa-missing' }], task, output)).toThrow('incomplete');
  });

  it('recovers usage accounting after the compliance receipt persisted but its usage write failed', async () => {
    await supplied();
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const write = vi.spyOn(usage, 'recordAssetUsageReceipt').mockRejectedValueOnce(new Error('interrupted usage write'));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    await checkPersistedCognitionOutput('user-a', input);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([]);
    await checkPersistedCognitionOutput('user-a', input);
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied' })]);
    write.mockRestore();
  });

  it('records unavailable model checking as unknown and creates no adoption or effectiveness claim', async () => {
    await supplied(); runModel.mockRejectedValue(new Error('unavailable'));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
  });

  it('retries a transient provider failure and keeps the subsequent completed observation', async () => {
    await supplied(); runModel.mockRejectedValueOnce(new Error('temporary outage'));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const first = await checkPersistedCognitionOutput('user-a', input);
    expect(first).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const recovered = await checkPersistedCognitionOutput('user-a', input);
    expect(recovered).toMatchObject({ id: first?.id, modelCompleted: true, checks: [{ status: 'complied' }] });
    await checkPersistedCognitionOutput('user-a', input);
    expect(runModel).toHaveBeenCalledTimes(2);
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toHaveLength(1);
  });

  it('records failure to follow guidance without treating it as rejection of the cognition', async () => {
    await supplied();
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ ...good, status: 'not_complied' }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: true, checks: [{ status: 'not_complied' }] });
    const { listAssetUsageReceipts, listAppliedUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', evidenceKind: 'final_output' })]);
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: ['turn-a'] })).toEqual([]);
    const { loadAssetAdoptionStats } = await import('../../../../src/main/features/recall/asset-catalog');
    expect((await loadAssetAdoptionStats('user-a')).get('aa-pref')?.contradictedCount || 0).toBe(0);
  });

  it('corrects an earlier agent adoption claim using the exact persisted output check', async () => {
    await supplied();
    const { finalizeAssetUsageClaims } = await import('../../../../src/main/features/recall/asset-usage-claim');
    const report = { taskRunId: input.taskRunId, messageId: input.messageId, finalText: output,
      claims: [{ assetId: asset.assetId, assetVersion: asset.version, outputExcerpt: good.outputEvidence.quote }] };
    await finalizeAssetUsageClaims('user-a', report);
    const { listAssetUsageReceipts, listAppliedUsageReceipts, listAssetUsageReceiptViews } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: ['turn-a'] })).toHaveLength(1);
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ ...good, status: 'not_complied' }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    await checkPersistedCognitionOutput('user-a', input);
    await finalizeAssetUsageClaims('user-a', report);
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'model_assisted' })]);
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: ['turn-a'] })).toEqual([]);
    expect(await listAssetUsageReceiptViews('user-a', asset.assetId)).toEqual([expect.objectContaining({ observationMethod: 'model_assisted' })]);
  });

  it('recognizes an explicit current request overriding a preference without contradiction', async () => {
    await supplied();
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: 'aa-pref', version: '1', status: 'not_applicable',
      taskEvidence: { quote: task, start: 0, end: task.length } }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ checks: [{ status: 'not_applicable' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'model_assisted', reason: expect.stringContaining('inapplicable') })]);
  });

  it('does not substitute current content for a missing historical snapshot', async () => {
    await supplied(); snapshot.mockResolvedValue(null);
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
  });

  it.each(['cognition', 'fact'])('checks actually supplied %s facts against the exact stored dates, not external truth', async type => {
    const fact = '合成项目甲验收：2026-09-24起由合成签字人甲签字；此前合成签字人乙负责的历史仍成立。';
    const factualOutput = '2026-09-25合成项目甲验收找合成签字人甲，2026-09-23找合成签字人乙，以2026-09-24为生效分界；这是根据你已保存的项目认识。';
    const factualTask = '准备合成项目甲验收材料，2026-09-25和2026-09-23各找谁签字？';
    snapshot.mockResolvedValue({ type, contentCategory: 'unclassified', statement: fact, applicableWhen: ['合成项目甲验收'], forbiddenWhen: [], evidenceRefs: [] });
    await supplied({}, factualOutput);
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: 'aa-pref', version: '1', status: 'complied', outputEvidence: { quote: factualOutput } }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const result = await checkPersistedCognitionOutput('user-a', { ...input, taskText: factualTask });
    expect(result).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied', version: '1' }] });
    expect(JSON.parse(runModel.mock.calls[0][1].message).assets[0].content).toBe(fact);
    expect(runModel.mock.calls[0][1].systemPrompt).toContain('not external fact verification');
    expect(runModel.mock.calls[0][1].systemPrompt).toContain('wrong person or date');
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ assetVersion: '1', status: 'applied', observationMethod: 'model_assisted', reason: expect.stringContaining('not external fact verification') })]);
  });

  it.each([
    { status: 'not_complied', answer: '2026-09-25合成项目甲验收仍由合成签字人乙签字。', request: '准备2026-09-25合成项目甲验收材料，找谁签字？' },
    { status: 'unknown', answer: '当前无法确定签字负责人，请先核对资料。', request: '准备合成项目甲验收材料，找谁签字？' },
    { status: 'not_applicable', answer: '本次整理合成项目乙材料，合成项目甲安排不适用。', request: '只讨论合成项目乙验收，不涉及合成项目甲。' },
  ])('does not mark a factual $status finding as adoption', async ({ status, answer, request }) => {
    snapshot.mockResolvedValue({ type: 'cognition', contentCategory: 'unclassified', statement: '合成项目甲验收2026-09-24起合成签字人甲负责，此前合成签字人乙负责。', applicableWhen: [], forbiddenWhen: [] });
    await supplied({}, answer);
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: 'aa-pref', version: '1', status, ...(status === 'not_complied' ? { outputEvidence: { quote: answer } } : {}), ...(status === 'not_applicable' ? { taskEvidence: { quote: request } } : {}) }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', { ...input, taskText: request })).toMatchObject({ checks: [{ status }] });
    const { listAppliedUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: ['turn-a'] })).toEqual([]);
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'model_assisted' })]);
  });

  it.each(['unknown', 'not_applicable'])('a completed %s check holds a prior same-output self-report without claiming non-use or ineffectiveness', async status => {
    await supplied();
    const { finalizeAssetUsageClaims } = await import('../../../../src/main/features/recall/asset-usage-claim');
    const claim = { taskRunId: input.taskRunId, messageId: input.messageId, finalText: output,
      claims: [{ assetId: asset.assetId, assetVersion: asset.version, outputExcerpt: good.outputEvidence.quote }] };
    await finalizeAssetUsageClaims('user-a', claim);
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: [input.taskRunId] })).toHaveLength(1);
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: asset.assetId, version: asset.version, status,
      ...(status === 'not_applicable' ? { taskEvidence: { quote: task } } : {}) }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    await checkPersistedCognitionOutput('user-a', input);
    await finalizeAssetUsageClaims('user-a', claim);
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'usage_unknown', observationMethod: 'model_assisted' })]);
    expect(await usage.listAppliedUsageReceipts('user-a', { taskRunIds: [input.taskRunId] })).toEqual([]);
  });

  it('a provider failure preserves a prior same-output self-report without inventing an independent finding', async () => {
    await supplied();
    const { finalizeAssetUsageClaims } = await import('../../../../src/main/features/recall/asset-usage-claim');
    await finalizeAssetUsageClaims('user-a', { taskRunId: input.taskRunId, messageId: input.messageId, finalText: output,
      claims: [{ assetId: asset.assetId, assetVersion: asset.version, outputExcerpt: good.outputEvidence.quote }] });
    runModel.mockRejectedValue(new Error('provider unavailable'));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', observationMethod: 'agent_reported' })]);
  });

  it.each([
    { status: 'rejected' }, { taskRunId: 'other-turn' }, { conversationId: 'other-chat' },
    { assetIds: [] }, { assetVersions: { 'aa-pref': '2' } }, { expiresAt: '2000-01-01T00:00:00Z' },
  ])('does not send facts to a model with stale or unbound projection: %j', async patch => {
    await supplied();
    projection.mockResolvedValue({ status: 'confirmed', taskRunId: 'turn-a', conversationId: 'cid-a', purpose: 'general', assetIds: ['aa-pref'], assetVersions: { 'aa-pref': '1' }, ...patch });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
  });

  it('rechecks current source access and the historical source refs before any model call', async () => {
    await supplied();
    snapshot.mockResolvedValue({ type: 'fact', statement: '原版本事实', contentCategory: 'unclassified', evidenceRefs: [{ id: 'revoked-original-source' }] });
    current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', evidenceRefs: [{ id: 'different-new-source' }] });
    readable.mockResolvedValue([]);
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(readable).toHaveBeenCalledWith('user-a', [expect.objectContaining({ evidenceRefs: [{ id: 'different-new-source' }] }),
      expect.objectContaining({ evidenceRefs: [{ id: 'revoked-original-source' }] })], expect.objectContaining({ purpose: 'general', taskText: task }));
    expect(runModel).not.toHaveBeenCalled();
  });

  it('does not let an enabled historical source hide a revoked current source', async () => {
    await supplied();
    snapshot.mockResolvedValue({ type: 'fact', statement: '原版本事实', contentCategory: 'unclassified', evidenceRefs: [{ id: 'enabled-historical' }] });
    current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', evidenceRefs: [{ id: 'revoked-current' }] });
    readable.mockImplementation(async (_user, rows) => rows.filter((row: { evidenceRefs: Array<{ id: string }> }) => !row.evidenceRefs.some(ref => ref.id === 'revoked-current')));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
  });

  it('holds access revoked during a model call as unknown, without recording adoption', async () => {
    await supplied();
    runModel.mockImplementationOnce(async () => { readable.mockResolvedValue([]); return { result: { text: JSON.stringify({ checks: [good] }), meta: {} } }; });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
  });

  it('does not recover an adoption claim from a cached completed observation after source access was revoked', async () => {
    await supplied();
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const write = vi.spyOn(usage, 'recordAssetUsageReceipt').mockRejectedValueOnce(new Error('interrupted adoption write'));
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ checks: [{ status: 'complied' }] });
    readable.mockResolvedValue([]);
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ checks: [{ status: 'unknown' }] });
    expect(await usage.listAssetUsageReceipts('user-a')).toEqual([]);
    expect(runModel).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it('does not persist adoption for a result edited while its model check was running', async () => {
    await supplied();
    runModel.mockImplementationOnce(async () => {
      const { appendJsonlAtomic } = await import('../../../../src/main/storage');
      const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
      await appendJsonlAtomic(conversationMessageFile('user-a', 'cid-a'), { id: 'message-a', from: 'commander', text: '核查中更改了结果', turn_id: 'turn-a' });
      return { result: { text: JSON.stringify({ checks: [good] }), meta: {} } };
    });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
  });

  it('does not choose one of two different supplied versions of the same cognition', async () => {
    await supplied(); await supplied({ assetVersion: '2' });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
  });

  it('keeps a legitimate supplied historical version rather than replacing it with the current body', async () => {
    await supplied();
    current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', version: '3', activeVersion: '3', statement: '不能代替历史版的当前正文', evidenceRefs: [] });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ checks: [{ version: '1', status: 'complied' }] });
    expect(JSON.parse(runModel.mock.calls[0][1].message).assets[0]).toMatchObject({ version: '1', content: asset.content });
  });

  it.each(['unsupported', 'budget'])('retains %s supplied items as unknown without a model call', async condition => {
    await supplied();
    snapshot.mockResolvedValue({ type: condition === 'unsupported' ? 'skill_method' : 'cognition', contentCategory: 'unclassified', statement: condition === 'budget' ? '完整事实'.repeat(25_000) : '只可检查有效认知', evidenceRefs: [] });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).not.toHaveBeenCalled();
  });

  it('does not count catalog hints or profile context as a task-authorized citation', async () => {
    await supplied({ channel: 'profile_memory' });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toBeUndefined();
    expect(runModel).not.toHaveBeenCalled();
  });

  it('reassesses native JSON syntax once with the full immutable context and original selected model route', async () => {
    await supplied();
    const chosen = { provider: 'zai', model: 'glm-5.2' };
    const invalid = '{"checks":[{"status":"complied","broken":]}';
    runModel.mockResolvedValueOnce({ result: { text: invalid, meta: {} }, chosen });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }] });
    expect(runModel).toHaveBeenCalledTimes(2);
    const initial = runModel.mock.calls[0][1], repair = runModel.mock.calls[1][1];
    expect(JSON.parse(repair.message)).toEqual({ ...JSON.parse(initial.message), invalidPreviousResponse: invalid });
    expect(repair.modelCandidates).toEqual([chosen]);
    expect(initial.responseFormat).toBe('json_object'); expect(repair.responseFormat).toBe('json_object');
    expect(repair.sessionId).toBe(initial.sessionId + '-syntax-repair');
    expect(await repair.shouldContinue()).toBe(true);
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', observationMethod: 'model_assisted' })]);
  });

  it('does not attempt a third call when syntax reassessment is still invalid', async () => {
    await supplied(); runModel.mockResolvedValue({ result: { text: '{bad json', meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    { checks: [] },
    { checks: [{ ...good, assetId: 'foreign-asset' }] },
    { checks: [{ ...good, outputEvidence: { quote: 'invented' } }] },
    { checks: [{ ...good, version: '99' }] },
    { checks: [{ ...good, outputEvidence: undefined }] },
  ])('never repairs a valid JSON semantic or evidence refusal: %j', async response => {
    await supplied(); runModel.mockResolvedValue({ result: { text: JSON.stringify(response), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'not_complied'])('does not repair a complete %s observation', async status => {
    await supplied(); runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ ...good, status }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: true, checks: [{ status }] });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it.each([{ error: 'provider unavailable' }, { aborted: true }])('does not repair provider failure or abort: %j', async meta => {
    await supplied(); runModel.mockResolvedValue({ result: { text: '{invalid', meta } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it('does not start checking an aborted request or repair a request aborted during the first call', async () => {
    await supplied(); const controller = new AbortController(); controller.abort();
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', { ...input, signal: controller.signal })).toBeUndefined();
    expect(runModel).not.toHaveBeenCalled();
    const running = new AbortController();
    runModel.mockImplementationOnce(async () => { running.abort(); return { result: { text: '{invalid', meta: {} } }; });
    expect(await checkPersistedCognitionOutput('user-a', { ...input, signal: running.signal })).toMatchObject({ modelCompleted: false });
    expect(runModel).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'scope', 'version', 'projection', 'result', 'injections'])('does not repair after the immutable %s baseline changes', async kind => {
    await supplied();
    runModel.mockImplementationOnce(async () => {
      if (kind === 'source') readable.mockResolvedValue([]);
      if (kind === 'scope') current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'project', version: '1', evidenceRefs: [] });
      if (kind === 'version') current.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', version: '2', activeVersion: '2', evidenceRefs: [] });
      if (kind === 'projection') projection.mockResolvedValue({ status: 'revoked' });
      if (kind === 'result') await supplied({}, 'Changed answer');
      if (kind === 'injections') await supplied({ assetVersion: '2' });
      return { result: { text: '{invalid', meta: {} } };
    });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false });
    expect(runModel).toHaveBeenCalledTimes(1);
    const { listAppliedUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: ['turn-a'] })).toEqual([]);
  });

  it('rejects a successful syntax reassessment if source access is lost during that call', async () => {
    await supplied(); runModel.mockResolvedValueOnce({ result: { text: '{invalid', meta: {} } });
    runModel.mockImplementationOnce(async () => { readable.mockResolvedValue([]); return { result: { text: JSON.stringify({ checks: [good] }), meta: {} } }; });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    expect(runModel).toHaveBeenCalledTimes(2);
  });

  it('does not truncate the immutable context to make room for a malformed previous response', async () => {
    await supplied({}, output + '证据'.repeat(46_500));
    runModel.mockResolvedValueOnce({ result: { text: '{' + ' '.repeat(5_000), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runModel.mock.calls[0][1].message).output).toBe(output + '证据'.repeat(46_500));
  });


  it.each([
    { name: 'unique real output quote with wrong end', outputEvidence: { quote: good.outputEvidence.quote, start: 0, end: good.outputEvidence.quote.length - 1 } },
    { name: 'correct output quote with wrong optional task end', outputEvidence: good.outputEvidence, taskEvidence: { quote: task, start: 0, end: task.length + 3 } },
    { name: 'unique real quote with a partial coordinate pair', outputEvidence: { quote: good.outputEvidence.quote, start: 0 } },
    { name: 'coordinates without a required quote', outputEvidence: { start: 0, end: good.outputEvidence.quote.length } },
  ])('holds invalid mixed evidence without retry or adoption: $name', async ({ outputEvidence, ...rest }) => {
    await supplied();
    expect(output.indexOf(good.outputEvidence.quote)).toBe(0);
    expect(output.indexOf(good.outputEvidence.quote, 1)).toBe(-1);
    const taskEvidence = 'taskEvidence' in rest ? rest.taskEvidence : undefined;
    runModel.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ ...good, outputEvidence, ...(taskEvidence ? { taskEvidence } : {}) }] }), meta: {} } });
    const { checkPersistedCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedCognitionOutput('user-a', input)).toMatchObject({ modelCompleted: false, checks: [{ assetId: asset.assetId, version: asset.version, status: 'unknown' }] });
    expect(runModel).toHaveBeenCalledTimes(1);
    const { listAppliedUsageReceipts, listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAppliedUsageReceipts('user-a', { taskRunIds: [input.taskRunId] })).toEqual([]);
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
  });

});
