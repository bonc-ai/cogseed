import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * search_ability_assets 工具契约测试。kb_embed 被 mock（不加载 ONNX），
 * recall 资产服务用真实实现（tmp 工作区）。
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'recalltools';

const embedState = vi.hoisted(() => ({ fail: false }));
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => {
    if (embedState.fail) throw new Error('embed unavailable');
    return texts.map(() => new Array(512).fill(0));
  },
  embedQuery: async () => {
    if (embedState.fail) throw new Error('embed unavailable');
    return new Array(512).fill(0);
  },
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recalltools-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const config = await import('../../../../src/main/features/config');
  config.writePreferences({ semantica_enabled: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let _seedSeq = 0;
async function seedAsset(
  judgment: string,
  opts: { spaceId?: string; scope?: string; pause?: boolean; title?: string } = {},
) {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  _seedSeq += 1;
  const candidate = await createNightlyCandidateFixture(TEST_UID, {
    judgment,
    rawStatement: true,
    // 标题闸门：judgment 前缀兜底命中「与正文开头重复」，
    // 改为与正文首字不同的合规样本标题。
    summary: opts.title || `检索样本${_seedSeq}`,
    suggestedType: 'rule',
    applicableWhen: ['正式评审与架构决策时'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: opts.scope || 'general',
    ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
    sourceRefs: [{ kind: 'execution', id: `exec-seed-${_seedSeq}` }],
  });
  const promoted = await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: 'user' });
  if (opts.pause) {
    await assets.pauseAbilityAsset(TEST_UID, promoted.asset.id, { actor: 'user', reason: 'not ready' });
  }
  return promoted.asset;
}

describe('recall search_ability_assets tool', () => {
  it('returns and validates the complete long cognition including its final restrictions before recording a full-version read', async () => {
    const tail = '末尾限制：仅用于人工审核，不授权发布；证据不足时应停止判断。';
    const body = '逐项保存本次判断的原始依据，并标明不能确定的部分。'.repeat(110) + tail;
    expect(body.length).toBeGreaterThan(2000); expect(body.length).toBeLessThanOrEqual(4000);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const candidate = await createNightlyCandidateFixture(TEST_UID, { judgment: body, rawStatement: true,
      summary: '完整判断依据', suggestedType: 'cognition', contentCategory: 'method', suggestedScope: 'general',
      sourceRefs: [], value: '以后人工审核时按完整依据和停止条件作出判断。' });
    const { asset } = await candidates.promoteRecallCandidate(TEST_UID, candidate.id, { actor: 'user' });
    const validation = await import('../../../../src/main/features/recall/ontology-answer-validation');
    const inspect = vi.spyOn(validation, 'validateOntologyAnswer');
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const suite = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-complete-body', taskText: '人工审核这次判断依据' });
    const tool = suite.tools.find(tool => tool.name === 'search_ability_assets')!;
    const result = await tool.execute({ assetIds: [asset.id] }, {} as never);
    expect(result.content).toContain(body);
    expect(result.content).toContain(tail);
    await suite.finalResponseGate.validate({ text: '证据不足时停止判断，不发布。' });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ assets: [expect.objectContaining({
      assetId: asset.id, version: asset.version, statement: body,
    })] }), expect.any(Object));
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-complete-body')).toEqual([
      expect.objectContaining({ channel: 'agent_read', assetId: asset.id, assetVersion: asset.version, status: 'injected' }),
    ]);
    // The shared runner budget can spill a whole result when context is full;
    // it keeps exact bytes and a read-chunk reference rather than cutting the
    // cognition locally or needing another recall-specific quota.
    const { capToolResult, DEFAULT_INLINE_RESULT_TOKENS } = await import('../../../../src/main/util/tool-result-cap');
    const spilled = capToolResult('search_ability_assets', result, { state: {
      toolResultInlineLedger: { initialTokens: 0, remainingTokens: 0 },
    } } as never, { maxInlineTokens: DEFAULT_INLINE_RESULT_TOKENS, toolResultsDir: path.join(tmpDir, 'complete-read-results') });
    expect(spilled.persistedOutput?.path).toBeTruthy();
    expect(fs.readFileSync(spilled.persistedOutput!.path, 'utf8')).toBe(result.content);
    expect(spilled.content).toContain('tool_result_read_chunk');
    expect(spilled.content).toContain('source_truncated="false"');
    inspect.mockRestore();
  });

  it('ontology_query follows governed asset relations and excludes paused assets', async () => {
    const gateway = await seedAsset('网关是服务调用的统一入口。', { scope: 'general', title: '本体查询示例：API网关' });
    const auth = await seedAsset('认证服务通过网关对外提供能力。', { scope: 'general', title: '本体查询示例：认证服务' });
    const client = await seedAsset('调用客户端先访问认证服务。', { scope: 'general', title: '本体查询示例：调用客户端' });
    const paused = await seedAsset('旧认证服务已经停用。', { scope: 'general', title: '本体查询示例：旧认证' });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(TEST_UID, auth.id, {
      relations: [{ kind: 'depends_on', assetId: gateway.id }], actor: 'user', reason: 'test relation',
    });
    await assets.updateAbilityAsset(TEST_UID, client.id, {
      relations: [{ kind: 'depends_on', assetId: auth.id }], actor: 'user', reason: 'test relation',
    });
    await assets.updateAbilityAsset(TEST_UID, paused.id, {
      relations: [{ kind: 'depends_on', assetId: gateway.id }], actor: 'user', reason: 'test relation',
    });
    await assets.pauseAbilityAsset(TEST_UID, paused.id, { actor: 'user', reason: 'not available' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const suite = createRecallToolSuite({
      userId: TEST_UID, turnId: 'turn-ontology01', cid: 'chat-ontology01',
    });
    const ontologyTool = suite.tools.find((tool) => tool.name === 'ontology_query')!;
    expect(suite.finalResponseGate.isRequired()).toBe(false);
    const response = await ontologyTool.execute({
      query: '哪些资产依赖 本体查询示例：API网关', maxHops: 2,
    }, {} as never);
    const result = JSON.parse(response.content);

    expect(response.isError).not.toBe(true);
    expect(result.status).toBe('ok');
    expect(result.target.id).toBe(gateway.id);
    expect(result.matches.map((match: { asset: { id: string }; distance: number }) => [match.asset.id, match.distance])).toEqual([
      [auth.id, 1],
      [client.id, 2],
    ]);
    expect(response.content).not.toContain(paused.id);
    expect(response.content).not.toContain('网关是服务调用的统一入口');
    expect(suite.finalResponseGate.isRequired()).toBe(true);
  });

  it('keeps the final response gate inactive for catalog and semantic-search modes', async () => {
    await seedAsset('竞品调研应先明确可比维度再收集证据。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const suite = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-gate-search' });
    const searchTool = suite.tools.find((tool) => tool.name === 'search_ability_assets')!;

    await searchTool.execute({}, {} as never);
    expect(suite.finalResponseGate.isRequired()).toBe(false);
    await searchTool.execute({ query: '竞品调研' }, {} as never);
    expect(suite.finalResponseGate.isRequired()).toBe(false);
  });

  it('activates final validation from automatic Semantica projection evidence', async () => {
    const entry = await seedAsset('聚餐前先确认参与人数和忌口。', { title: '周末聚会安排' });
    const venue = await seedAsset('餐厅选择依赖参与人数和忌口信息。', { title: '聚会地点筛选' });
    const answerValidation = await import('../../../../src/main/features/recall/ontology-answer-validation');
    const validateSpy = vi.spyOn(answerValidation, 'validateOntologyAnswer');
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const initialEvidence = {
      taskText: '原始任务：安排一次预算内的周末聚会。\n当前补充：改成周日下午。',
      assets: [
        { assetId: entry.id, title: entry.title, version: entry.version, statement: entry.statement },
        { assetId: venue.id, title: venue.title, version: venue.version, statement: venue.statement },
      ],
      relations: [{
        query: '下周聚餐怎么安排',
        paths: [{
          entryAssetId: entry.id,
          entryTitle: entry.title,
          assetId: venue.id,
          assetTitle: venue.title,
          distance: 1,
          relationKind: 'depends_on' as const,
          direction: 'incoming' as const,
          maxHops: 1,
          evidencePath: [{
            fromAssetId: venue.id, fromTitle: venue.title, kind: 'depends_on' as const,
            toAssetId: entry.id, toTitle: entry.title,
          }],
        }],
      }],
    };
    const suite = createRecallToolSuite({
      userId: TEST_UID,
      taskText: '下周聚餐怎么安排',
      turnId: 'turn-auto-evidence',
      initialEvidence,
    });

    expect(suite.finalResponseGate.isRequired()).toBe(true);
    const accepted = await suite.finalResponseGate.validate({
      text: `${venue.title} [asset:${venue.id}] 直接依赖${entry.title} [asset:${entry.id}]。`,
    });
    expect(accepted.text).toContain('直接依赖');

    const natural = await suite.finalResponseGate.validate({
      text: '先确认参与人数和忌口，再据此筛选合适的聚餐地点。',
    });
    expect(natural.text).toBe('先确认参与人数和忌口，再据此筛选合适的聚餐地点。');
    expect(natural.text).not.toContain('[asset:');
    expect(validateSpy).toHaveBeenCalledWith(expect.objectContaining({
      query: initialEvidence.taskText,
    }), expect.objectContaining({ mode: 'observe' }));

    const reversed = await suite.finalResponseGate.validate({
      text: `${entry.title} [asset:${entry.id}] 直接依赖${venue.title} [asset:${venue.id}]。`,
    });
    expect(reversed.text).toContain('当前已确认可用的经验');
    expect(reversed.text).toContain('先确认参与人数和忌口');
    expect(reversed.text).not.toContain('[asset:');
    expect(reversed.text).not.toContain('-depends_on->');
    expect(reversed.text).not.toContain('跳');
    expect(reversed.text).not.toBe(`${entry.title} [asset:${entry.id}] 直接依赖${venue.title} [asset:${venue.id}]。`);
  });

  it('ignores automatic initial evidence while Semantica is disabled', async () => {
    const live = await seedAsset('关闭本体模式时仍可按原流程读取的经验。', { title: '传统检索经验' });
    vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const suite = createRecallToolSuite({
      userId: TEST_UID,
      initialEvidence: {
        assets: [{ assetId: 'aa-hidden', title: '不应进入', version: '1', statement: '隐藏正文' }],
        relations: [],
      },
    });
    expect(suite.finalResponseGate.isRequired()).toBe(false);
    expect(suite.tools.some((tool) => tool.name === 'ontology_query')).toBe(false);

    const searchTool = suite.tools.find((tool) => tool.name === 'search_ability_assets')!;
    await searchTool.execute({ assetIds: [live.id] }, {} as never);
    expect(suite.finalResponseGate.isRequired()).toBe(false);
    await expect(suite.finalResponseGate.validate({ text: '保留模型生成的完整回答。' }))
      .resolves.toEqual({ text: '保留模型生成的完整回答。' });
  });

  it('采用工具只交给宿主待核验报告，版本未供应时拒绝且不写回执', async () => {
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const claims: unknown[] = [];
    const report = createRecallToolSuite({ userId: TEST_UID, turnId: 'usage-turn',
      suppliedAbilityAssets: [{ assetId: 'asset-report', assetVersion: '1' }],
      onAssetUsageClaim: (claim) => { claims.push(claim); },
    }).tools.find((tool) => tool.name === 'report_ability_asset_usage')!;
    const input = { assetId: 'asset-report', assetVersion: 'v1', outputExcerpt: '每项待办都明确写出责任人以及可核对的验收条件。' };
    expect((await report.execute(input, {} as never)).content).toContain('尚未生成采用回执');
    expect(claims).toEqual([input]);
    expect((await report.execute({ ...input, assetVersion: '2' }, {} as never)).isError).toBe(true);
    expect(claims).toHaveLength(1);
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts(TEST_UID)).toEqual([]);
  });
  it('searches the GLOBAL pool (all spaces + general assets) and returns citation format', async () => {
    await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('番茄工作法：25 分钟专注加 5 分钟休息。', { scope: 'general' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const result = await tool.execute({ query: '竞品调研' }, {} as never);

    expect(result.isError).not.toBe(true);
    const content = result.content;
    // 全局池全量可见：sp_a / sp_b / general 的资产都能搜到
    expect(content).toContain('发布类公告');
    expect(content).toContain('竞品调研');
    expect(content).toContain('番茄工作法');
    // 引用格式与元信息
    expect(content).toContain('[asset:');
    expect(content).toContain('引用格式');
    expect(content).toContain('空间:sp_a');
  });

  it('supports scope / spaceId filters and excludes non-active assets', async () => {
    const spA = await seedAsset('只在本空间使用的经验。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('另一个空间的经验。', { spaceId: 'sp_b', scope: 'space' });
    await seedAsset('已停用的经验。', { spaceId: 'sp_a', scope: 'space', pause: true });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;

    const filtered = await tool.execute({ query: '经验', spaceId: 'sp_a' }, {} as never);
    expect(filtered.content).toContain('只在本空间使用');
    expect(filtered.content).not.toContain('另一个空间');
    expect(filtered.content).not.toContain('已停用');
    expect(filtered.content).toContain(`[asset:${spA.id}]`);

    const scopeFiltered = await tool.execute({ query: '经验', scope: 'space' }, {} as never);
    expect(scopeFiltered.content).toContain('只在本空间使用');
    expect(scopeFiltered.content).not.toContain('番茄工作法');
  });

  it('applies role, conversation-kind and file-kind scope from the turn context', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const asset = await seedAsset('受角色与会话限制的经验：仅在评审场景使用。', { scope: 'general', title: '范围上下文样本' });
    await assets.updateAbilityAsset(TEST_UID, asset.id, {
      scopePolicy: { roleIds: ['role-a'], conversationKinds: ['group'], fileKinds: ['pdf'] },
      reason: 'scope context test', actor: 'user',
    });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [allowedTool] = createRecallToolSuite({
      userId: TEST_UID, roleId: 'role-a', conversationKind: 'group', fileKinds: ['pdf'],
    }).tools;
    const allowed = await allowedTool.execute({ query: '受角色与会话限制' }, {} as never);
    expect(allowed.content).toContain(`[asset:${asset.id}]`);

    const [deniedTool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const denied = await deniedTool.execute({ query: '受角色与会话限制' }, {} as never);
    expect(denied.content).not.toContain(`[asset:${asset.id}]`);
  });

  it('目录模式：不给 query 也不给 assetIds 时返回全量目录，含判断适配需要的字段', async () => {
    const a = await seedAsset('发布类公告应包含背景、变更点、影响范围、生效时间、联系方式五段。', { spaceId: 'sp_a', scope: 'space' });
    await seedAsset('已停用的经验。', { spaceId: 'sp_a', scope: 'space', pause: true });
    await seedAsset('番茄工作法：25 分钟专注加 5 分钟休息。', { scope: 'general' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;

    const catalog = await tool.execute({}, {} as never);
    expect(catalog.isError).not.toBe(true);
    // 目录是"在用资产的全量"：未停用的两条都在，停用的不在。
    expect(catalog.content).toContain('认知资产目录');
    expect(catalog.content).toContain('发布类公告');
    expect(catalog.content).toContain('番茄工作法');
    expect(catalog.content).not.toContain('已停用的经验');
    expect(catalog.content).toContain(`[asset:${a.id}]`);
    // 模型据此判断适配所需的字段：
    // 标题 — 一句话 / 类型·范围·成熟度·版本·使用次数 ｜ 适用首条。
    expect(catalog.content).toContain('规则');
    expect(catalog.content).toContain('space');
    expect(catalog.content).toMatch(/v\d/);
    expect(catalog.content).toContain('未验证');   // 刀三两态：bud 也显示未验证
    expect(catalog.content).toContain('没用过');
    expect(catalog.content).toContain('适用:正式评审与架构决策时');
    // 禁用场景不进目录（由服务端硬闸执行；读取与注入块里完整给出）。
    expect(catalog.content).not.toContain('内部快速对齐');
    // 取用指引：按需取正文 + 引用格式。
    expect(catalog.content).toContain('assetIds');
    expect(catalog.content).toContain('[asset:<id>]');

    // 过滤与分页
    const byType = await tool.execute({ type: 'rule' }, {} as never);
    expect(byType.content).toContain('过滤：type=rule');
    const byScope = await tool.execute({ scope: 'space', spaceId: 'sp_a' }, {} as never);
    expect(byScope.content).toContain('发布类公告');
    expect(byScope.content).not.toContain('番茄工作法');
    const page = await tool.execute({ k: 1, offset: 0 }, {} as never);
    expect(page.content).toContain('本页 1-1 条');
    expect(page.content).toMatch(/还有 \d+ 条：用 offset=1/);
    const page2 = await tool.execute({ k: 1, offset: 1 }, {} as never);
    expect(page2.content).toContain('本页 2-2 条');
  });

  it('正文模式：按 id 取正文，过准入门，并写 agent_read 注入回执 + 使用流水', async () => {
    const live = await seedAsset('性能类提问需用真实日志做分层归因，先给链路再给瓶颈。', { scope: 'general' });
    const paused = await seedAsset('已停用的经验。', { scope: 'general', pause: true });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/usage-service');
    const suite = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-read0001' });
    const tool = suite.tools.find((entry) => entry.name === 'search_ability_assets')!;
    expect(suite.finalResponseGate.isRequired()).toBe(false);

    const read = await tool.execute({ assetIds: [live.id] }, {} as never);
    expect(read.isError).not.toBe(true);
    expect(read.content).toContain('已取出 1 条资产正文');
    expect(read.content).toContain(`[asset:${live.id}]`);
    expect(read.content).toContain('正文:');
    expect(read.content).toContain('先给链路再给瓶颈');
    expect(read.content).toMatch(/版本:v\d/);
    expect(suite.finalResponseGate.isRequired()).toBe(true);
    // 留痕：模型自己取用也算一次真实带入（否则自选资产进不了升档链）。
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001');
    expect(rows.map((row) => `${row.channel}:${row.assetId}`)).toEqual([`agent_read:${live.id}`]);
    expect(rows[0].boundary).toBe('real');
    expect(rows[0].status).toBe('injected');
    const used = await usage.listRecallUsage(TEST_UID, live.id);
    expect(used.map((row) => row.outcome)).toEqual(['agent_read']);
    expect(used[0].taskRunId).toBe('turn-read0001');

    // 同一回合重复取用：不重复刷使用次数（回执幂等 + 使用按回合计一次）。
    await tool.execute({ assetIds: [live.id] }, {} as never);
    expect(await usage.listRecallUsage(TEST_UID, live.id)).toHaveLength(1);
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001')).toHaveLength(1);

    // 准入被拦的资产：如实说明原因，不返回正文、不写留痕。
    const blocked = await tool.execute({ assetIds: [paused.id] }, {} as never);
    expect(blocked.content).toContain('当前不可使用');
    expect(blocked.content).toContain('已暂停/归档/撤销');
    expect(blocked.content).not.toContain('正文:');
    expect((await receipts.listInjectionReceipts(TEST_UID, 'turn-read0001')).some((row) => row.assetId === paused.id)).toBe(false);

    // 不存在的 id：如实说未找到。
    const missing = await tool.execute({ assetIds: ['aa-doesnotexist0001'] }, {} as never);
    expect(missing.content).toContain('未找到');
  });

  it('正文模式：单次取用上限 6 条，超出部分提示忽略；没有 turnId 时不记账', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const asset = await seedAsset(`第 ${i} 条经验：用于验证正文模式的条数上限。`, { scope: 'general' });
      ids.push(asset.id);
    }
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-read0002' }).tools;
    const read = await tool.execute({ assetIds: ids }, {} as never);
    expect(read.content).toContain('已取出 6 条资产正文');
    expect(read.content).toContain('单次最多 6 条');
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-read0002')).toHaveLength(6);

    // 缺 turnId（没有回合并定位）：只读不记账，绝不写脏回执。
    const [noTurn] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const readNoTurn = await noTurn.execute({ assetIds: [ids[0]] }, {} as never);
    expect(readNoTurn.isError).not.toBe(true);
    expect(await receipts.listInjectionReceipts(TEST_UID)).toHaveLength(6);
  });

  it('检索结果只记展示；按 ID 取正文后才记 agent_read', async () => {
    const asset = await seedAsset('竞品调研应先明确可比维度（范围/功能/定价/体验）再收集证据。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-search001' }).tools;
    const result = await tool.execute({ query: '竞品调研' }, {} as never);
    expect(result.content).toContain('竞品调研');
    expect(await receipts.listInjectionReceipts(TEST_UID, 'turn-search001')).toHaveLength(0);
    const observationPath = path.join(tmpDir, TEST_UID, 'local', 'recall', 'catalog-observations', `${new Date().toISOString().slice(0, 7)}.jsonl`);
    const events = fs.readFileSync(observationPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { assetId: string; stage: string });
    expect(events).toContainEqual(expect.objectContaining({ assetId: asset.id, stage: 'search_result_shown' }));
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-search001');
    expect(rows.some((row) => row.assetId === asset.id && row.channel === 'agent_read')).toBe(true);
  });

  it('searches profile memory with an explicit source label', async () => {
    const paths = await import('../../../../src/main/paths');
    const profileFile = paths.userProfileFile(TEST_UID);
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, '用户是本程序的开发人员，技术问题按内部排查口径处理。', 'utf8');

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;

    const result = await tool.execute({ query: '开发人员' }, {} as never);
    expect(result.isError).not.toBe(true);
    // 画像可被检索到，且带来源与等级标注——LLM 必须能区分记忆与经验。
    expect(result.content).toContain('用户是本程序的开发人员');
    expect(result.content).toMatch(/\[asset:onto-/);
    expect(result.content).toContain('来源:遗留画像记忆(user_profile)，仅供参考');
    expect(result.content).toContain('画像记忆 1');
    // spaceId 过滤把画像排除（记忆无空间归属）。
    const filtered = await tool.execute({ query: '开发人员', spaceId: 'sp_a' }, {} as never);
    expect(filtered.content).not.toContain('用户是本程序的开发人员');
    // scope 精确过滤：画像 scope=general，按值参与过滤。
    const scopeKept = await tool.execute({ query: '开发人员', scope: 'general' }, {} as never);
    expect(scopeKept.content).toContain('用户是本程序的开发人员');
  });

  /**
   * Catalog output is an index, not full asset content. These assertions bound
   * its request cost independently of the full-text read path.
   */
  it('目录预算：每条平均 ≤ 110 字符，一句话不残缺（不以标点结尾）', async () => {
    const filler = '先给结论、再给依据、最后给下一步动作；遇到数据缺口时先说明缺口而不是硬给结论。'.repeat(3);
    const longBody = `这是一条用于压测目录预算的资产正文，它刻意写得比较长以便观察目录输出是否仍然便宜：${filler}`;
    for (let index = 0; index < 8; index += 1) {
      await seedAsset(`${longBody}（第 ${index + 1} 条）`, { scope: 'general' });
    }
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const catalog = await tool.execute({ k: 30 }, {} as never);

    const lines = catalog.content.split('\n');
    const entryHeads = lines.filter((line) => /^\d+\. \[asset:/.test(line));
    const entryChars = lines
      .filter((line) => /^\d+\. \[asset:/.test(line) || /^ \S/.test(line))
      .reduce((sum, line) => sum + line.length + 1, 0);
    const wrapperChars = catalog.content.length - entryChars;
    // eslint-disable-next-line no-console
    console.log(`[budget] 8 条目录：每条平均=${Math.round(entryChars / Math.max(1, entryHeads.length))}，页眉页脚=${wrapperChars}，总计=${catalog.content.length}`);
    expect(entryHeads).toHaveLength(8);
    expect(entryChars / entryHeads.length).toBeLessThanOrEqual(110);
    // 页眉页脚也要便宜：30 条页 ≈ 30×110 + 页眉页脚 ≤ 4000。
    expect(wrapperChars).toBeLessThanOrEqual(250);

    // 一句话 = 正文首句（压缩后紧跟在标题后用 ` — ` 引出），必须切得干净：
    // 不以逗号/顿号/分号/破折号收尾，且 ≤ 80 字。
    const headLine = catalog.content.split('\n').find((line) => /^\d+\. \[asset:/.test(line)) || '';
    const oneLine = headLine.split(' — ')[1] || '';
    expect(oneLine.length).toBeGreaterThan(0);
    expect(/[，、；：,;:\-—]$/.test(oneLine)).toBe(false);
    expect(oneLine.length).toBeLessThanOrEqual(80);
  });

  it('目录采用次数与带入流水分开；同回合重复正文读取只记一次', async () => {
    const asset = await seedAsset('口径核对：目录里的使用次数必须与使用流水一致。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const [tool] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-count0001' }).tools;
    await tool.execute({ assetIds: [asset.id] }, {} as never);
    await tool.execute({ assetIds: [asset.id] }, {} as never);   // 同回合第二次取用
    const catalog1 = await tool.execute({ k: 30 }, {} as never);
    expect(catalog1.content).toContain('没用过');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(1);

    const [nextTurn] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-count0002' }).tools;
    await nextTurn.execute({ assetIds: [asset.id] }, {} as never);
    const catalog2 = await nextTurn.execute({ k: 30 }, {} as never);
    expect(catalog2.content).toContain('没用过');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(2);
  });

  it('目录边界（可用性）：offset 越界给"已到末尾+总数"，k 超上限被夹住，过滤无匹配说明当前不可用', async () => {
    for (let index = 0; index < 3; index += 1) {
      await seedAsset(`分页用例第 ${index + 1} 条经验。`, { scope: 'space' });
    }
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;

    const beyond = await tool.execute({ offset: 99 }, {} as never);
    expect(beyond.isError).not.toBe(true);
    expect(beyond.content).toContain('已到目录末尾');
    expect(beyond.content).toContain('共 3 条');

    const capped = await tool.execute({ k: 999 }, {} as never);
    const heads = capped.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line)).length;
    expect(heads).toBe(3);

    const noMatch = await tool.execute({ type: 'skill_method' }, {} as never);
    expect(noMatch.content).toContain('当前条件下没有可用于本任务的认知资产');
    expect(noMatch.content).toContain('type=skill_method');

    const byScope = await tool.execute({ scope: 'space' }, {} as never);
    expect(byScope.content).toContain('过滤：scope=space');
    expect(byScope.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line))).toHaveLength(3);
  });

  it('读取硬闸（可用性）：命中禁用场景的资产被拒且给原因；暂停资产同样被拒', async () => {
    const forbidden = await seedAsset('这条资产声明了禁用场景：只在内部快速对齐时不可用。', { scope: 'general' });
    const paused = await seedAsset('这条资产已暂停。', { scope: 'general', pause: true });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, taskText: '内部快速对齐：先对齐口径' }).tools;

    const blocked = await tool.execute({ assetIds: [forbidden.id] }, {} as never);
    expect(blocked.content).toContain('当前不可使用');
    expect(blocked.content).toContain('禁用场景');
    expect(blocked.content).not.toContain('正文:');

    const pausedRead = await tool.execute({ assetIds: [paused.id] }, {} as never);
    expect(pausedRead.content).toContain('已暂停/归档/撤销');
  });

  it('读取去重与非法 id（可用性）：重复 id 只取一次；不存在与非安全 id 各给明确提示', async () => {
    const asset = await seedAsset('去重用例：同一条资产传两次只应返回一份正文。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-dedup0001' }).tools;
    const usage = await import('../../../../src/main/features/recall/usage-service');

    const dup = await tool.execute({ assetIds: [asset.id, asset.id] }, {} as never);
    expect(dup.content).toContain('已取出 1 条资产正文');
    expect(await usage.listRecallUsage(TEST_UID, asset.id)).toHaveLength(1);

    const mixed = await tool.execute({ assetIds: [asset.id, 'aa-doesnotexist00', '../etc/passwd'] }, {} as never);
    expect(mixed.content).toContain('未找到');
    expect(mixed.content).toContain('不是合法的资产 id');
    expect(mixed.content).toContain('已取出 1 条资产正文');
  });

  it('关键词降级（健壮性）：embedding 不可用时仍按关键词命中，不报错', async () => {
    await seedAsset('竞品调研维度：范围、功能、定价、体验四层先定清楚。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    embedState.fail = true;
    try {
      const result = await tool.execute({ query: '竞品调研' }, {} as never);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('竞品调研');
    } finally {
      embedState.fail = false;
    }
  });

  it('画像记忆不写 agent_read 账（口径）：检索命中画像也不产生资产使用记录', async () => {
    const paths = await import('../../../../src/main/paths');
    const profileFile = paths.userProfileFile(TEST_UID);
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, '用户的画像记忆：偏好结论先行。', 'utf8');
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const receipts = await import('../../../../src/main/features/recall/injection-receipt');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, turnId: 'turn-profile001' }).tools;
    const result = await tool.execute({ query: '画像记忆' }, {} as never);
    expect(result.content).toMatch(/\[asset:onto-/);
    const rows = await receipts.listInjectionReceipts(TEST_UID, 'turn-profile001');
    expect(rows.filter((row) => String(row.assetId).startsWith('onto-'))).toHaveLength(0);
  });

  it('被准入拦下的 personal 资产不会通过 onto 虚拟条目绕回检索结果', async () => {
    const asset = await seedAsset('秘密画像规则：只允许正式评审使用。', { scope: 'general' });
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await updateRecallJsonRecord(TEST_UID, 'ability-assets', asset.id, (current) => ({ ...(current || {}), type: 'personal' } as never));
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, taskText: '内部快速对齐' }).tools;
    const result = await tool.execute({ query: '秘密画像规则' }, {} as never);
    expect(result.content).not.toContain('秘密画像规则');
    expect(result.content).not.toContain(`[asset:${asset.id}]`);
  });

  it('归档/已删除资产不进目录，目录头计数与实际条目一致', async () => {
    const kept = await seedAsset('保留资产：会出现在目录里。', { scope: 'general' });
    const archived = await seedAsset('归档资产：不该出现在目录里。', { scope: 'general' });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.archiveAbilityAsset(TEST_UID, archived.id, { actor: 'user', reason: 'merge target' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const catalog = await tool.execute({ k: 30 }, {} as never);
    expect(catalog.content).toContain('保留资产');
    expect(catalog.content).not.toContain('归档资产');
    expect(catalog.content).toContain(`[asset:${kept.id}]`);
    const heads = catalog.content.split('\n').filter((line) => /^\d+\. \[asset:/.test(line)).length;
    expect(catalog.content).toContain(`当前可用 1 条`);
    expect(heads).toBe(1);
  });

  it('使用统计缓存（效率）：同回合复用快照，新回合重算，无回合不缓存', async () => {
    const asset = await seedAsset('缓存用例：30 秒内不重扫流水。', { scope: 'general' });
    const catalog = await import('../../../../src/main/features/recall/asset-catalog');
    const usage = await import('../../../../src/main/features/recall/usage-service');
    catalog.resetAssetUsageStatsCacheForTest();

    const first = await catalog.loadAssetUsageStatsCached(TEST_UID, 'turn-cache0001');
    expect(first.get(asset.id)?.count ?? 0).toBe(0);
    await usage.recordRecallUsage(TEST_UID, { assetId: asset.id, assetVersion: '1', taskRunId: 'turn-cache0001', outcome: 'agent_read', boundary: 'real' });

    // 同一回合：复用快照（不重扫）；新回合：重算，算上刚写入的那条。
    const sameTurn = await catalog.loadAssetUsageStatsCached(TEST_UID, 'turn-cache0001');
    expect(sameTurn.get(asset.id)?.count ?? 0).toBe(0);
    const nextTurn = await catalog.loadAssetUsageStatsCached(TEST_UID, 'turn-cache0002');
    expect(nextTurn.get(asset.id)?.count).toBe(1);
    // 没有回合上下文时直读，不缓存（宁可慢，不可错）。
    const noTurn = await catalog.loadAssetUsageStatsCached(TEST_UID);
    expect(noTurn.get(asset.id)?.count).toBe(1);
  });

  it('常驻目录按 token 预算截取，完整资产池仍可由工具分页访问', async () => {
    for (let index = 0; index < 31; index += 1) {
      await seedAsset(`超限用例第 ${index + 1} 条：库里很大时提示词不应被目录撑爆。`, { scope: 'general' });
    }
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    hint.resetAssetCatalogHintCacheForTest();
    const block = await hint.assetCatalogForPrompt(TEST_UID);
    expect(block).toContain('31 assets are available');
    const inline = block.split('\n').filter((line) => /^\d+\. \[asset:/.test(line));
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.length).toBeLessThanOrEqual(12);
    expect(block).toContain('query');
    expect(block).toContain('search_ability_assets');
    // 模型看到索引而非整库正文。
    expect(block.length).toBeLessThanOrEqual(3000);
  });

  it('常驻目录小库可发现，空池不产块，每次构建重新检查准入', async () => {
    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    hint.resetAssetCatalogHintCacheForTest();
    expect(await hint.assetCatalogForPrompt(TEST_UID)).toBe('');

    for (let index = 0; index < 3; index += 1) {
      await seedAsset(`常驻目录用例第 ${index + 1} 条：命中时应给出一行目录。`, { scope: 'general' });
    }
    hint.resetAssetCatalogHintCacheForTest();
    const block = await hint.assetCatalogForPrompt(TEST_UID);
    expect(block).toContain('Asset catalog: 3 assets are available');
    expect(block).toContain('[asset:');
    expect(block.split('\n').filter((line) => /^\d+\. \[asset:/.test(line))).toHaveLength(3);

    // 预算：常驻目录不得把提示词撑爆（≤ 30 条 × ~110 字符 + 头尾 ≈ 3.6KB）。
    expect(block.length).toBeLessThanOrEqual(3600);

    // 同样输入产生同样文本；准入不会复用旧文本。
    const cached = await hint.assetCatalogForPrompt(TEST_UID);
    expect(cached).toBe(block);
    const afterTtl = await hint.assetCatalogForPrompt(TEST_UID, Date.now() + 61_000);
    expect(afterTtl).toBe(block);
  });

  it('目录体量与常用词（效率）：常驻目录复用同一份紧凑格式，不产生第二套写法', async () => {
    await seedAsset('格式一致性：工具目录与常驻目录必须是同一套行格式。', { scope: 'general' });
    const shared = await import('../../../../src/main/features/recall/asset-catalog');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const list = (await assets.listAbilityAssets(TEST_UID)).filter((asset) => asset.status === 'active');
    const line = shared.formatCatalogEntries(list, new Map(), 1)[0];
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const catalog = await tool.execute({ k: 30 }, {} as never);
    expect(catalog.content).toContain(line);
  });

  it('模式优先级（契约）：同时给 query 与 assetIds 走正文模式；只给 k 走目录模式', async () => {
    const asset = await seedAsset('模式优先级：assetIds 优先于 query。', { scope: 'general' });
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const both = await tool.execute({ query: '模式优先级', assetIds: [asset.id] }, {} as never);
    expect(both.content).toContain('已取出 1 条资产正文');
    expect(both.content).not.toContain('返回最相关的');
    const catalogOnly = await tool.execute({ k: 5 }, {} as never);
    expect(catalogOnly.content).toContain('认知资产目录');
  });

  it('目录体量 ≤ 正文注入上限的三分之一（同批资产对照）', async () => {
    const filler = '数据缺口时先说明缺口，不要编造计时数字。'.repeat(6);
    const body = `性能类提问必须用真实日志做分层归因：先拆链路、再定位瓶颈、最后只给一个可优化项。${filler}`;
    for (let index = 0; index < 8; index += 1) await seedAsset(`${body}（第 ${index + 1} 条）`, { scope: 'general' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const catalog = await tool.execute({ k: 30 }, {} as never);
    const ids = (await assets.listAbilityAssets(TEST_UID)).slice(0, 6).map((asset) => asset.id);
    const fullText = await tool.execute({ assetIds: ids }, {} as never);
    // eslint-disable-next-line no-console
    console.log(`[budget] 目录字符=${catalog.content.length}；6 条正文字符=${fullText.content.length}；正文块上限=14000`);
    // 注入块整块上限 14000 字：8 条资产的目录必须显著低于它，否则目录化没有意义。
    expect(catalog.content.length * 3).toBeLessThanOrEqual(14000);
    expect(fullText.content.length).toBeGreaterThan(catalog.content.length);
  });

// 目录相关度标记：★ 标记 + 相关优先排序（在 hint 侧，工具目录
// 模式共条目格式——此测试锁 formatCatalogEntry 的标记输出）。
describe('catalog relevance mark', () => {
  it('formatCatalogEntry marks relevant assets with a star', async () => {
    const { formatCatalogEntry } = await import('../../../../src/main/features/recall/asset-catalog');
    const asset = {
      id: 'aa-rel-1', type: 'rule', title: '周报格式', statement: '周报三个板块。',
      scope: 'report', maturity: 'bud', version: '1', status: 'active',
    } as never;
    const plain = formatCatalogEntry(asset, undefined, 1, false);
    const marked = formatCatalogEntry(asset, undefined, 1, true);
    expect(plain).not.toContain('★');
    expect(marked).toContain('★[asset:aa-rel-1]');
  });
});

// 推荐排序接线：工具目录模式与提示词常驻目录共调
// asset-ranking.rankAssets 的同一推荐分——同一次会话里两处看到同一顺序；
// 语义检索（runSearch）保持纯余弦，不受行为信号（采用回执）影响。
describe('catalog ranking parity', () => {
  const idsOf = (text: string) => [...text.matchAll(/^\d+\.\s(?:★)?\[asset:([^\]]+)\]/gm)].map((m) => m[1]);

  it('工具目录第一页与提示词常驻目录同序（同一 scene 输入下逐位一致）', async () => {
    const spaceHit = await seedAsset('空间命中资产：scene 因子应把它排到最前。', { spaceId: 'sp-rank-01', scope: 'space' });
    await seedAsset('普通资产甲：不命中场景，靠其余因子与兜底序。', { scope: 'general' });
    await seedAsset('普通资产乙：不命中场景，靠其余因子与兜底序。', { scope: 'general' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID, spaceId: 'sp-rank-01', projectId: 'pj-rank-01' }).tools;
    const catalog = await tool.execute({ k: 30 }, {} as never);
    expect(catalog.isError).not.toBe(true);
    const toolIds = idsOf(catalog.content);
    expect(toolIds).toHaveLength(3);
    // 空间命中 = scene 1.0，必须排最前（scene 因子真实接进了工具目录排序）。
    expect(toolIds[0]).toBe(spaceHit.id);

    const hint = await import('../../../../src/main/features/recall/asset-catalog-hint');
    hint.resetAssetCatalogHintCacheForTest();
    const promptText = await hint.assetCatalogForPrompt(TEST_UID, 'conv-rank-parity', Date.now(), '', {
      turnProjectId: 'pj-rank-01', turnSpaceId: 'sp-rank-01',
    });
    const promptIds = idsOf(promptText);
    expect(promptIds).toHaveLength(3);
    // 同序验收：提示词看到的顺序与工具目录第一页一致。
    expect(promptIds).toEqual(toolIds);
    // 只排不裁：三 条全量都在两份目录里。
    expect(new Set(toolIds)).toEqual(new Set(promptIds));
    expect(new Set(toolIds).size).toBe(3);
  });

  it('检索模式不受行为信号影响：写 applied 采用回执后 runSearch 逐位不变，而目录顺序改变（对照）', async () => {
    const first = await seedAsset('较早创建的资产：写采用回执后应在目录里升到第一。', { scope: 'general' });
    const second = await seedAsset('较晚创建的资产：兜底序（updatedAt）原本在前面。', { scope: 'general' });

    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const [tool] = createRecallToolSuite({ userId: TEST_UID }).tools;
    const searchBefore = await tool.execute({ query: '资产', k: 30 }, {} as never);
    const catalogBefore = idsOf((await tool.execute({ k: 30 }, {} as never)).content);
    expect(new Set(catalogBefore)).toEqual(new Set([first.id, second.id]));

    // 写一条 applied && boundary='real' 的 usage 回执（经注入回执外键，真实链路）。
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
    const injection = await injections.recordInjectionReceipt(TEST_UID, {
      taskRunId: 'turn-rank-adopt-1', projectionId: 'proj-1', assetId: first.id,
      assetVersion: '1', boundary: 'real', status: 'injected', messageId: 'msg-rank-adopt-1',
    });
    await usage.recordAssetUsageReceipt(TEST_UID, {
      taskRunId: 'turn-rank-adopt-1', projectionId: 'proj-1', assetId: first.id,
      assetVersion: '1', injectionReceiptId: injection.id, status: 'applied',
      evidenceKind: 'tool_call', evidenceRefs: [{ kind: 'conversation', id: 'conv-rank-adopt' }],
      boundary: 'real',
    });

    // 检索模式：纯余弦，对行为信号完全无感（逐位不变）。
    const searchAfter = await tool.execute({ query: '资产', k: 30 }, {} as never);
    expect(searchAfter.content).toBe(searchBefore.content);
    // 对照组：目录模式同一份行为信号生效——有采用回执的资产升到第一。
    const catalogAfter = idsOf((await tool.execute({ k: 30 }, {} as never)).content);
    expect(catalogAfter).not.toEqual(catalogBefore);
    expect(catalogAfter[0]).toBe(first.id);
    expect(new Set(catalogAfter)).toEqual(new Set([first.id, second.id]));
  });

});

});

it('reports unassessed search results, reuses that batch and preserves explicit full reads', async () => {
  const asset = await seedAsset('Synthetic reviews retain the signed decision evidence.', { title: 'Synthetic decision method' });
  const semantic = await import('../../../../src/main/features/recall/semantic-applicability');
  const assess = vi.spyOn(semantic, 'assessSemanticApplicability').mockResolvedValue({ decisions: [],
    unassessed: [{ assetId: asset.id, version: asset.version, reason: 'candidate_limit' }] });
  try {
    const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
    const suite = createRecallToolSuite({ userId: TEST_UID, taskText: 'Review the signed decision evidence.', turnId: 'unassessed-search' });
    const search = suite.tools.find(tool => tool.name === 'search_ability_assets')!;
    const first = await search.execute({ query: 'signed decision evidence' }, {} as never);
    expect(first.content).toContain('not_evaluated: semantic_applicability_candidate_limit');
    expect(first.content).not.toContain(asset.statement);
    await search.execute({ query: 'signed decision evidence' }, {} as never);
    expect(assess).toHaveBeenCalledTimes(1);
    const explicit = await search.execute({ assetIds: [asset.id] }, {} as never);
    expect(explicit.content).toContain(asset.statement);
    expect(assess).toHaveBeenCalledTimes(1);
  } finally { assess.mockRestore(); }
});
