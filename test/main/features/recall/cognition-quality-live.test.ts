/** Explicitly opt-in: one isolated two-night scenario, with real model outputs.
 * Auth stays in a separate tool-free ephemeral process using its normal adapter.
 * Fixtures and approvals below exist only under a new OS-temporary root. */
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
const live = vi.hoisted(() => ({ calls: 0, tokens: 0, stages: [] as string[] }));
vi.mock('../../../../src/main/features/auth', () => ({ listEntriesForUser: async () => ({ entries: [{ provider: 'live', model: 'configured' }] }),
  hasConfiguredModelForUser: () => ({ configured: true }), hasConfiguredModel: () => ({ configured: true }),
  getConfiguredModelOAuthExpiredMessageForUser: () => null, getConfiguredModelOAuthExpiredMessage: () => null }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: async (options: { sessionId: string; systemPrompt: string }) => ({ runner: {
  run: async (input: { message: string; signal?: AbortSignal }) => {
    live.stages.push(options.sessionId);
    const transcriptDir = path.join(process.env.COGSEED_WORKSPACE_ROOT!, 'live-model-transcripts');
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, `${Date.now()}-${(await fs.readdir(transcriptDir)).length + 1}.json`);
    const request = { systemPrompt: options.systemPrompt, message: input.message };
    for (const name of await fs.readdir(transcriptDir)) {
      const previous = JSON.parse(await fs.readFile(path.join(transcriptDir, name), 'utf8'));
      if (previous.response && previous.request.systemPrompt === request.systemPrompt && previous.request.message === request.message) return previous.response;
    }
    if (++live.calls > 14) throw new Error('live acceptance call budget exceeded');
    await fs.writeFile(transcriptFile, JSON.stringify({ request }));
    const result = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('test/helpers/recall-live-model-proxy.cjs')], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
      child.on('error', reject); child.on('close', code => {
        const marker = output.lastIndexOf('@@RECALL_LIVE@@');
        if (code !== 0 || marker < 0) {
          fs.writeFile(transcriptFile, JSON.stringify({ request, adapterError: error.slice(-4000), adapterOutput: output.slice(-4000) })).finally(() => reject(new Error(`live model adapter failed (${code}): ${error.slice(-1200)}`)));
        }
        else try { resolve(JSON.parse(output.slice(marker + '@@RECALL_LIVE@@'.length).trim())); } catch (error) { reject(error); }
      });
      const abort = () => child.kill('SIGTERM');
      input.signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => input.signal?.removeEventListener('abort', abort));
      if (input.signal?.aborted) abort();
      child.stdin.end(JSON.stringify({ systemPrompt: options.systemPrompt, message: input.message }));
    });
    await fs.writeFile(transcriptFile, JSON.stringify({ request, response: result }));
    live.tokens += Number(result.meta?.usage?.totalTokens || 0);
    return result;
  },
} }) }));

it.skipIf(process.env.COGSEED_RECALL_LIVE !== '1')('real-model isolated two-night quality lifecycle', async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 12, 3));
  const root = process.env.COGSEED_RECALL_LIVE_FIXTURE_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-quality-live-'));
  if (!(await fs.realpath(root)).startsWith(await fs.realpath(os.tmpdir()))) throw new Error('live fixtures require OS-temporary isolation');
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  vi.stubEnv('COGSEED_RECALL_LIVE_FIXTURE_ROOT', root);
  const uid = 'quality-live-user', cid = 'quality-live-conversation';
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const chats = await import('../../../../src/main/features/chats');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const records = await import('../../../../src/main/features/execution-records');
  const binding = await import('../../../../src/main/features/recall/execution-result-content');
  const projections = await import('../../../../src/main/features/recall/context-projection');
  const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
  const proofs = await import('../../../../src/main/features/recall/proof-service');
  const feedback = await import('../../../../src/main/features/recall/effectiveness-feedback');
  const paths = await import('../../../../src/main/features/recall/paths');
  if (!await chats.getConversation(uid, cid)) await chats.createConversation(uid, { conversationId: cid, title: '隔离验收：会议准备' });
  const add = async (id: string, from: string, text: string, ts: string, extra = {}) => {
    if (!(await storage.readJsonl<{ id: string }>(layout.conversationMessageFile(uid, cid))).some(row => row.id === id))
      await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, cid), { id, from, to: [from === 'user' ? 'commander' : 'user'], text, ts, ...extra });
  };
  await add('source-user', 'user', '会前材料只有议题会让大家到场后才开始找资料，也说不清谁拍板。会议准备应列出会议目标、背景事实、待决策问题、负责人和下一步行动，这样大家可以事先看证据并明确责任。今后项目会议都按这个结构，临时闲聊不用。', '2026-10-11T02:00:00.000Z');
  await add('source-assistant', 'commander', '我建议额外要求每份材料都超过十页。', '2026-10-11T02:01:00.000Z');
  await add('source-ack', 'user', '收到。今天这一份请用蓝色标题，仅限这次。', '2026-10-11T02:02:00.000Z');
  await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
  const stop = capture.startRecallCaptureOrchestrator();
  const captureRows = async () => {
    const dir = path.dirname(paths.recallJsonRecordPath(uid, 'captures', 'placeholder'));
    const names = await fs.readdir(dir); return Promise.all(names.filter(name => name.endsWith('.json')).map(name => capture.readRecallCapture(uid, name.slice(0, -5))));
  };
  try {
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    const first = (await captureRows()).find(row => !row.feedbackObservations?.length)!; expect(first).toBeDefined();
    // Resume only this disposable fixture checkpoint after a diagnosed failure.
    const resumeCapture = async (record: Awaited<ReturnType<typeof capture.readRecallCapture>>) => {
      if (record.status === 'failed') await (await import('../../../../src/main/features/recall/store')).updateRecallJsonRecord(uid, 'captures', record.id, current => ({ ...current!, status: 'queued' }));
      const running = record.status === 'queued' || record.status === 'failed' ? await capture.runRecallCapture(uid, record.id) : record;
      if (running.status !== 'extracting') return running;
      let settled = running;
      await vi.waitFor(async () => { settled = await capture.readRecallCapture(uid, record.id); expect(settled.status).not.toBe('extracting'); }, { interval: 250, timeout: 300_000 });
      return settled;
    };
    expect((await resumeCapture(first)).status).toBe('review_ready');
    const formed = (await candidates.listRecallCandidates(uid)).filter(row => row.captureProvenance?.captureId === first.id);
    expect(formed.length).toBeGreaterThan(0);
    expect(formed.every(row => !/十页|蓝色/.test(row.judgment))).toBe(true);
    const proposal = formed.find(row => /负责人/.test(row.judgment))!; expect(proposal).toBeDefined();
    const saved = proposal.promotedAssetId ? { asset: await assets.readAbilityAsset(uid, proposal.promotedAssetId) } : await candidates.promoteRecallCandidate(uid, proposal.id, { actor: 'user' });
    const task = '请准备项目会议材料，讨论下周的部署安排。已知需求是分批上线，由示例工程师确认部署清单，下一步核对窗口。写出具体内容，不要只列空标题。';
    // Ordinary model-driven read/attachment entrypoint: no maturity fabrication.
    const tools = (await import('../../../../src/main/model/core-agent/recall-tools')).createRecallToolSuite({ userId: uid, cid, turnId: 'quality-result', taskText: task });
    const search = tools.tools.find(tool => tool.name === 'search_ability_assets')!;
    const hints = await search.execute({ query: task }, {} as never); expect(JSON.stringify(hints)).toContain(saved.asset.id);
    const body = await search.execute({ assetIds: [saved.asset.id] }, {} as never); expect(String(body.content)).toContain(saved.asset.statement);
    const projection = (await projections.listAllContextProjections(uid)).find(row => row.taskRunId === 'quality-result') || await projections.previewContextProjection(uid, { taskRunId: 'quality-result', conversationId: cid,
      purpose: 'conversation_reply', taskText: task, authorization: 'model_selected', explicitAssetIds: [saved.asset.id], confirm: true });
    const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
    const generate = async (id: string, guidance: string) => {
      const cacheFile = path.join(root, `${id}.md`);
      const cached = await fs.readFile(cacheFile, 'utf8').catch(() => undefined);
      if (cached !== undefined) return cached;
      const { runner } = await buildRunner({ sessionId: `one-shot-${id}`, systemPrompt: '完成给定任务。只输出完整 Markdown 正文，不要声明保存或使用了资产。', disableTools: true, ephemeralSession: true, userId: uid });
      const text = (await runner.run({ message: task + guidance })).text;
      await fs.writeFile(cacheFile, text); return text;
    };
    const resultText = await generate('quality-result', '\n本次完整已确认指导：' + saved.asset.statement);
    const persist = async (turn: string, text: string, assetRefs: string[]) => {
      const id = `turn-${turn}`; const file = path.join(layout.chatAttachmentDirForConversation(uid, cid), `${turn}.md`);
      const existing = await records.read(uid, id).catch(() => undefined);
      if (existing?.status === 'completed' && existing.resultMessage && existing.resultMessage !== 'pending') return { id, file };
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
      await records.create(uid, { executionId: id, kind: 'core-agent', sessionId: `one-shot-${turn}`, conversationId: cid, agentId: 'commander', boundary: 'real', permissionMode: 'read-only', bindResultMessage: true });
      await receipts.prepareReceipt(uid, { executionId: id, targetSessionId: `one-shot-${turn}`, reusedRefs: assetRefs, omittedRefs: [], permissionMode: 'read-only', allowedScopes: ['cognition:inherited'], boundary: 'real' }, { sessionId: `one-shot-${turn}` });
      await records.complete(uid, id, { status: 'completed', output: '材料已准备完成。' });
      const message = { id: `reply-${turn}`, from: 'commander', text: '材料已准备完成。', turn_id: turn, turn_end: true, produced: [file], ts: '2026-10-12T04:00:00.000Z', to: ['user'] };
      await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, cid), message);
      await binding.bindExecutionResultMessage(uid, id, cid, message);
      return { id, file };
    };
    const result = await persist('quality-result', resultText, [`asset:${saved.asset.id}@v1`]);
    const transfer = (await proofs.listTransferProofs(uid)).find(row => row.executionId === result.id) || await proofs.prepareTransferProof(uid, { projectionId: projection.id, executionId: result.id, expectedResultSnapshot: '会议材料具体列出目标、背景事实、待决策问题、负责人和下一步行动，不把蓝色标题或十页当作长期要求。' });
    if (transfer.status !== 'succeeded') await proofs.completeTransferProofWithReceipt(uid, transfer.id, { status: 'succeeded', receiptExecutionId: result.id, observedTransfer: '完整正文已用于产物生成。' });
    const feedbackNote = '模板帮助补齐背景事实。';
    const assessment = (await proofs.listEffectivenessProofs(uid)).find(row => row.transferProofId === transfer.id && row.observedResult === feedbackNote) || await feedback.recordEffectivenessFeedback(uid, { transferProofId: transfer.id, feedback: 'positive', note: feedbackNote });
    // Positive feedback records an evaluation; without a result comparison it
    // does not claim a verified effect.
    expect(assessment.outcome).toBe('insufficient_evidence');
    await add('source-correction', 'user', '原来的项目会议准备结构继续保留。部署评审时必须额外列出风险和回退条件，否则讨论不出安全的上线决定；普通会议不加这两栏。这是原方法的适用例外，不是所有会议都要加长。', '2026-10-12T05:00:00.000Z');
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    // Outcome feedback and the new user correction are separate capture groups.
    // Positive feedback alone correctly yields no candidate; update the group
    // that actually contains the new, user-authored exception.
    const second = (await captureRows()).find(row => row.messageIds.includes('source-correction'))!; expect(second).toBeDefined();
    expect((await resumeCapture(second)).status).toBe('review_ready');
    const correction = (await candidates.listRecallCandidates(uid)).find(row => row.status === 'pending_review' && row.targetAssetId === saved.asset.id)!; expect(correction).toBeDefined();
    expect(correction.targetVersionUsed).toBe('1');
    await candidates.promoteRecallCandidate(uid, correction.id, { actor: 'user' });
    const revised = await assets.readAbilityAsset(uid, saved.asset.id);
    expect(revised.version).toBe('2'); expect(revised.statement).toMatch(/回退/); expect(revised.statement).toMatch(/负责人/);
    expect(await assets.readAbilityAssetVersionSnapshot(uid, saved.asset.id, '1')).toMatchObject({ statement: saved.asset.statement });
    const transcripts = await Promise.all((await fs.readdir(path.join(root, 'live-model-transcripts'))).map(async name => JSON.parse(await fs.readFile(path.join(root, 'live-model-transcripts', name), 'utf8'))));
    const actualResponses = transcripts.filter(row => row.response);
    await fs.writeFile(path.join(root, 'acceptance-result.json'), JSON.stringify({ calls: actualResponses.length, reportedTokens: actualResponses.reduce((sum, row) => sum + Number(row.response.meta?.usage?.totalTokens || 0), 0), lastRunStages: live.stages, assetId: saved.asset.id, finalVersion: revised.version, feedbackOutcome: assessment.outcome, root }, null, 2));
    process.stdout.write(`\nQUALITY_LIVE_RESULT ${root}/acceptance-result.json\n`);
  } finally { stop(); vi.useRealTimers(); await drainMainRuntimeForTest(uid); vi.unstubAllEnvs(); }
}, 900_000);
