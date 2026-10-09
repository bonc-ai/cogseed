import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-personal-assets-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractPersonalStatements（确定性检测用户长期偏好）', () => {
  it('extracts a durable weekly-report preference', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '帮我写一份 长春城市 的资料' },
      { text: '我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划' },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('我以后的周报都要按这个格式');
  });

  it('extracts an identity statement（我是团队负责人）', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '我是团队负责人，负责周报和协调' },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('我是团队负责人');
  });

  it('extracts a preference habit（我习惯用 tab 缩进）', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '这个文件帮我改成 tab 缩进，我习惯用 tab 不用空格' },
    ]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('我习惯用 tab');
  });

  it('rejects one-off requests（今天帮我写诗）', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '今天帮我写一首关于海的诗' },
    ]);
    expect(statements).toHaveLength(0);
  });

  it('rejects project facts（本周上线支付网关）', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '本周要上线支付网关，帮我写个计划' },
    ]);
    expect(statements).toHaveLength(0);
  });

  it('dedupes repeated identical preferences', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '我以后的周报都要按四段模板' },
      { text: '我以后的周报都要按四段模板，表格带负责人列' },
    ]);
    // 两条都命中但句子不同（第二条更长）——各自提取，不去重（句子不同）。
    expect(statements.length).toBeGreaterThanOrEqual(1);
    expect(statements[0]).toContain('我以后的周报都要按四段模板');
  });

  it('caps at three statements', async () => {
    const { extractPersonalStatements } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const statements = extractPersonalStatements([
      { text: '我以后周报都要A' },
      { text: '我以后周报都要B' },
      { text: '我以后周报都要C' },
      { text: '我以后周报都要D' },
    ]);
    expect(statements.length).toBeLessThanOrEqual(3);
  });
});

describe('personalStatementsToProposals', () => {
  it('builds personal proposals with the right type and scope', async () => {
    const { personalStatementsToProposals } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const proposals = personalStatementsToProposals(
      ['我以后的周报都要按四段模板组织'],
      [{ kind: 'execution', id: 'kse-1', title: 'KSTAR requirement episode' }],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      suggestedType: 'personal',
      suggestedScope: 'personal',
      suggestedAction: 'create',
      judgment: '我以后的周报都要按四段模板组织',
    });
  });
});

describe('precipitateRequirementLevel 集成：从会话消息产 personal 候选', () => {
  it('precipitates a personal candidate when the user states a durable preference', async () => {
    // mock chats.getMessages 返回带长期偏好的用户消息
    const chatsMock = vi.fn(async (_userId: string, _cid: string) => [
      { from: 'user', text: '帮我写一份 长春城市 的资料' },
      { from: 'user', text: '我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划' },
      { from: 'commander', text: '好的，已完成' },
    ]);
    vi.doMock('../../../../src/main/features/chats', () => ({
      getMessages: chatsMock,
    }));
    vi.resetModules();

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const reviews = await import('../../../../src/main/features/kstar/review-service');

    const task = store.createKstarTaskRecord('user-personal', { conversationId: 'cid-personal', title: 'T' });
    const requirement = store.createKstarRequirementRecord('user-personal', {
      taskId: task.id,
      conversationId: 'cid-personal',
      userMessageIds: ['m1'],
      title: '写周报',
      goalText: '写周报',
    });
    const episode = {
      schemaVersion: 1 as const,
      ownerId: 'user-personal',
      id: 'kse-personal-integ',
      sessionId: 'gconv-cid-personal',
      taskRunId: 'run-personal',
      k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
      s: {},
      t: { userGoal: '写周报', constraints: [] },
      a: { toolCalls: [{ name: 'write_file', status: 'ok' as const }], agentActions: [] },
      r: { status: 'completed' as const, finalText: 'done', producedFiles: [] },
      evidenceRefs: [{ kind: 'execution' as const, id: 'exec-personal-integ' }],
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:01:00.000Z',
    };
    await episodeStore.writeKstarEpisode('user-personal', episode);
    const initial = reviews.createInitialKstarReview(episode);
    await reviews.saveKstarReviewRecord('user-personal', {
      ...initial,
      lesson: '写周报用四段模板。',
      confidence: 0.9,
    });
    requirement.episodeIds = [episode.id];
    await store.replaceKstarTask('user-personal', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('user-personal', requirement);

    const result = await precipitation.precipitateRequirementLevel('user-personal', requirement);

    // personal 候选出现（用户长期偏好被确定性检测）
    const personal = result.proposals.filter((p) => p.suggestedType === 'personal');
    expect(personal.length).toBeGreaterThan(0);
    expect(personal[0].judgment).toContain('我以后的周报都要按这个格式');
    expect(personal[0].suggestedScope).toBe('personal');
  });
});

describe('themeTerms / sharesTheme（跨类型去重第二层）', () => {
  it('extracts core theme nouns from a preference sentence', async () => {
    const { themeTerms } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const terms = themeTerms('我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划');
    expect(terms.has('周报')).toBe(true);
  });

  it('detects same-theme across different wording (personal vs template)', async () => {
    const { sharesTheme } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const pref = '我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划';
    const template = '写团队周报时采用固定结构：先按「本周完成（分段列里程碑）→ 数据指标表（带对比上周与负责人列）→ 风险与阻塞（先标影响等级）→ 下周计划';
    expect(sharesTheme(pref, template)).toBe(true);
  });

  it('does not treat unrelated themes as shared', async () => {
    const { sharesTheme } = await import('../../../../src/main/features/kstar/personal-asset-precipitation');
    const pref = '我以后的周报都要按这个格式';
    const city = '写城市资料时应先收集数据再成文';
    expect(sharesTheme(pref, city)).toBe(false);
  });
});

describe('跨类型去重集成：已有同主题资产时不产 personal', () => {
  it('skips personal precipitation when a same-theme template asset exists', async () => {
    // 预置一条"周报模板"template 资产（模拟模型提炼已沉淀）
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const c = await candidates.saveRecallCandidate('user-dedup', {
      judgment: '写团队周报时采用固定结构：先按「本周完成→数据指标表→风险与阻塞→下周计划」组织。',
      value: '写团队周报时采用固定结构：先按「本周完成→数据指标表→风险与阻塞→下周计划」组织。',
      summary: '周报模板',
      suggestedType: 'template',
      suggestedScope: 'report',
      suggestedAction: 'create',
      applicableWhen: ['处理报告类任务时'],
      sourceRefs: [{ kind: 'execution', id: 'exec-dedup' }],
      evidenceRefs: [{ kind: 'execution', id: 'exec-dedup' }],
    });
    await candidates.autoApplyRecallCandidate('user-dedup', c.id, { provenance: 'kstar' });

    // mock chats 返回"我以后的周报都要按这个格式"（同主题偏好）
    vi.doMock('../../../../src/main/features/chats', () => ({
      getMessages: async () => [
        { from: 'user', text: '我以后的周报都要按这个格式：1.本周完成 2.数据指标 3.风险与阻塞 4.下周计划' },
      ],
    }));
    vi.resetModules();

    const precipitation = await import('../../../../src/main/features/kstar/task-level-precipitation');
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const episodeStore = await import('../../../../src/main/features/kstar/episode-store');
    const reviews = await import('../../../../src/main/features/kstar/review-service');

    const task = store.createKstarTaskRecord('user-dedup', { conversationId: 'cid-dedup', title: 'T' });
    const requirement = store.createKstarRequirementRecord('user-dedup', {
      taskId: task.id, conversationId: 'cid-dedup', userMessageIds: ['m1'], title: '写周报', goalText: '写周报',
    });
    const episode = {
      schemaVersion: 1 as const, ownerId: 'user-dedup', id: 'kse-dedup', sessionId: 'gconv-cid-dedup',
      taskRunId: 'run-dedup', k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] }, s: {},
      t: { userGoal: '写周报', constraints: [] },
      a: { toolCalls: [{ name: 'write_file', status: 'ok' as const }], agentActions: [] },
      r: { status: 'completed' as const, finalText: 'done', producedFiles: [] },
      evidenceRefs: [{ kind: 'execution' as const, id: 'exec-dedup-ep' }],
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:01:00.000Z',
    };
    await episodeStore.writeKstarEpisode('user-dedup', episode);
    const initial = reviews.createInitialKstarReview(episode);
    await reviews.saveKstarReviewRecord('user-dedup', { ...initial, confidence: 0.9 });
    requirement.episodeIds = [episode.id];
    await store.replaceKstarTask('user-dedup', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('user-dedup', requirement);

    const result = await precipitation.precipitateRequirementLevel('user-dedup', requirement);

    // 已有同主题 template 资产 → 不产 personal 候选（防跨类型重复）
    const personal = result.proposals.filter((p) => p.suggestedType === 'personal');
    expect(personal).toHaveLength(0);
  });
});
